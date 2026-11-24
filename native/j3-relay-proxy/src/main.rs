use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(15);
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(30);
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const STATIC_CACHE_MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const STATIC_CACHE_MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_KEEP_ALIVE_REQUESTS: usize = 100;
const WORKER_THREAD_STACK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
struct ProxyConfig {
    listen: String,
    upstream: String,
    auth_token: Option<String>,
    max_connections: usize,
    static_dir: Option<PathBuf>,
}

impl ProxyConfig {
    fn from_args_and_env() -> Result<Self, String> {
        let mut listen = env::var("J3_RELAY_LISTEN").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
        let mut upstream =
            env::var("J3_RELAY_UPSTREAM").unwrap_or_else(|_| "127.0.0.1:3773".to_string());
        let mut auth_token = env::var("J3_RELAY_AUTH_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let mut max_connections: usize = env::var("J3_RELAY_MAX_CONNECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(256);
        let mut static_dir = env::var("J3_RELAY_STATIC_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);

        let args: Vec<String> = env::args().skip(1).collect();
        let mut idx = 0;
        while idx < args.len() {
            match args[idx].as_str() {
                "--version" | "-V" => {
                    println!("{}", env!("CARGO_PKG_VERSION"));
                    std::process::exit(0);
                }
                "--help" | "-h" => {
                    println!(
                        "j3-relay-proxy {}\nUsage: j3-relay-proxy [--listen HOST:PORT] [--upstream HOST:PORT] [--auth-token TOKEN] [--max-connections N] [--static-dir DIR]\nNote: --auth-token protects all routes except /healthz (including static assets).",
                        env!("CARGO_PKG_VERSION")
                    );
                    std::process::exit(0);
                }
                "--listen" => {
                    idx += 1;
                    listen = args
                        .get(idx)
                        .ok_or_else(|| "--listen requires HOST:PORT".to_string())?
                        .clone();
                }
                "--upstream" => {
                    idx += 1;
                    upstream = args
                        .get(idx)
                        .ok_or_else(|| "--upstream requires HOST:PORT".to_string())?
                        .clone();
                }
                "--auth-token" => {
                    idx += 1;
                    let token = args
                        .get(idx)
                        .ok_or_else(|| "--auth-token requires a value".to_string())?
                        .trim()
                        .to_string();
                    auth_token = if token.is_empty() { None } else { Some(token) };
                }
                "--max-connections" => {
                    idx += 1;
                    max_connections = args
                        .get(idx)
                        .ok_or_else(|| "--max-connections requires a positive integer".to_string())?
                        .parse::<usize>()
                        .map_err(|_| "--max-connections must be a positive integer".to_string())?;
                }
                "--static-dir" => {
                    idx += 1;
                    let dir = args
                        .get(idx)
                        .ok_or_else(|| "--static-dir requires a directory path".to_string())?
                        .trim()
                        .to_string();
                    static_dir = if dir.is_empty() {
                        None
                    } else {
                        Some(PathBuf::from(dir))
                    };
                }
                other => return Err(format!("unknown argument: {other}")),
            }
            idx += 1;
        }

        if max_connections == 0 {
            return Err("--max-connections must be at least 1".to_string());
        }

        let canonical_static = match static_dir {
            Some(dir) => {
                let canon = fs::canonicalize(&dir)
                    .map_err(|err| format!("--static-dir '{}' is not accessible: {err}", dir.display()))?;
                if !canon.is_dir() {
                    return Err(format!("--static-dir '{}' is not a directory", dir.display()));
                }
                Some(canon)
            }
            None => None,
        };

        Ok(Self {
            listen,
            upstream,
            auth_token,
            max_connections,
            static_dir: canonical_static,
        })
    }
}

#[derive(Clone)]
struct CachedStaticAsset {
    bytes: Arc<Vec<u8>>,
    content_type: &'static str,
    content_encoding: Option<&'static str>,
    etag: String,
    cache_control: &'static str,
    mtime_secs: u64,
    size: u64,
}

struct StaticCache {
    entries: HashMap<PathBuf, CachedStaticAsset>,
    total_bytes: usize,
}

impl StaticCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
        }
    }
}

struct SharedState {
    config: ProxyConfig,
    active_connections: AtomicUsize,
    shutdown: AtomicBool,
    static_cache: RwLock<StaticCache>,
}

struct ConnectionGuard {
    state: Arc<SharedState>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.state.active_connections.fetch_sub(1, Ordering::SeqCst);
    }
}

struct ParsedRequestHead {
    method: String,
    target: String,
    auth_header: Option<String>,
    if_none_match: Option<String>,
    accept_gzip: bool,
    keep_alive: bool,
    has_body_framing: bool,
    is_upgrade: bool,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let max_len = a.len().max(b.len());
    let mut diff: u8 = if a.len() == b.len() { 0 } else { 1 };
    for i in 0..max_len {
        let ba = a.get(i).copied().unwrap_or(0);
        let bb = b.get(i).copied().unwrap_or(0);
        diff |= ba ^ bb;
    }
    diff == 0
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| pos + 4)
}

fn read_http_head(stream: &mut TcpStream, carry: &mut Vec<u8>) -> io::Result<Option<Vec<u8>>> {
    let mut buffer = std::mem::take(carry);
    if find_header_end(&buffer).is_some() {
        return Ok(Some(buffer));
    }
    let mut chunk = [0u8; 4096];
    loop {
        let n = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::ConnectionReset
                ) && buffer.is_empty() =>
            {
                return Ok(None);
            }
            Err(err) => return Err(err),
        };
        if n == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            return Ok(Some(buffer));
        }
        buffer.extend_from_slice(&chunk[..n]);
        if find_header_end(&buffer).is_some() {
            return Ok(Some(buffer));
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP header exceeds 64KB limit",
            ));
        }
    }
}

fn write_simple_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
    keep_alive: bool,
) -> io::Result<()> {
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: {conn}\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn parse_request_head(head: &[u8]) -> Option<ParsedRequestHead> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.1");

    let mut auth_header = None;
    let mut if_none_match = None;
    let mut accept_gzip = false;
    let mut keep_alive = version.eq_ignore_ascii_case("HTTP/1.1");
    let mut has_body_framing = false;
    let mut is_upgrade = false;

    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            let value = value.trim();
            if name.eq_ignore_ascii_case("authorization") {
                auth_header = Some(value.to_string());
            } else if name.eq_ignore_ascii_case("if-none-match") {
                if_none_match = Some(value.to_string());
            } else if name.eq_ignore_ascii_case("accept-encoding") {
                if value.to_ascii_lowercase().contains("gzip") {
                    accept_gzip = true;
                }
            } else if name.eq_ignore_ascii_case("connection") {
                let lower = value.to_ascii_lowercase();
                if lower.contains("close") {
                    keep_alive = false;
                } else if lower.contains("keep-alive") {
                    keep_alive = true;
                }
                if lower.contains("upgrade") {
                    is_upgrade = true;
                }
            } else if name.eq_ignore_ascii_case("upgrade") {
                if !value.is_empty() {
                    is_upgrade = true;
                }
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                has_body_framing = true;
            } else if name.eq_ignore_ascii_case("content-length") {
                if value.parse::<u64>().map(|n| n > 0).unwrap_or(true) {
                    has_body_framing = true;
                }
            }
        }
    }

    Some(ParsedRequestHead {
        method,
        target,
        auth_header,
        if_none_match,
        accept_gzip,
        keep_alive,
        has_body_framing,
        is_upgrade,
    })
}

fn is_authorized(expected_token: &str, auth_header: Option<&str>) -> bool {
    let Some(header) = auth_header else {
        return false;
    };
    let Some((scheme, token)) = header.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer")
        && constant_time_eq(token.trim().as_bytes(), expected_token.as_bytes())
}

fn decode_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = decode_hex_nibble(bytes[i + 1])?;
            let lo = decode_hex_nibble(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "webmanifest") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn resolve_static_candidate(static_root: &Path, target: &str) -> Option<(PathBuf, &'static str)> {
    let raw_path = target.split('?').next().unwrap_or(target);
    if !raw_path.starts_with('/') {
        return None;
    }
    // Never intercept API, WebSocket, or RPC paths; forward them to the upstream server.
    if raw_path.starts_with("/api/")
        || raw_path == "/api"
        || raw_path.starts_with("/ws")
        || raw_path.starts_with("/rpc")
        || raw_path.starts_with("/events")
    {
        return None;
    }

    let decoded = percent_decode(raw_path)?;
    let trimmed = decoded.trim_start_matches('/');
    let rel_str = if trimmed.is_empty() { "index.html" } else { trimmed };
    // Reject traversal, backslashes, or null bytes after percent-decoding.
    if rel_str.contains('\0') || rel_str.contains('\\') || rel_str.split('/').any(|s| s == "..") {
        return None;
    }

    let candidate = static_root.join(rel_str);
    let canon = fs::canonicalize(&candidate).ok()?;
    if !canon.starts_with(static_root) || !canon.is_file() {
        return None;
    }

    let cache_control = if rel_str.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=60"
    };
    Some((canon, cache_control))
}

fn load_static_asset(
    state: &SharedState,
    static_root: &Path,
    target: &str,
    accept_gzip: bool,
) -> Option<CachedStaticAsset> {
    let (plain_path, cache_control) = resolve_static_candidate(static_root, target)?;
    let content_type = content_type_for_path(&plain_path);

    // Prefer a pre-compressed `.gz` sibling when the client accepts gzip.
    let (disk_path, content_encoding) = if accept_gzip {
        let mut gz_os = plain_path.as_os_str().to_os_string();
        gz_os.push(".gz");
        let gz_path = PathBuf::from(gz_os);
        if let Ok(gz_canon) = fs::canonicalize(&gz_path)
            && gz_canon.starts_with(static_root)
            && gz_canon.is_file()
        {
            (gz_canon, Some("gzip"))
        } else {
            (plain_path, None)
        }
    } else {
        (plain_path, None)
    };

    let meta = fs::metadata(&disk_path).ok()?;
    let size = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Ok(cache) = state.static_cache.read()
        && let Some(entry) = cache.entries.get(&disk_path)
        && entry.size == size
        && entry.mtime_secs == mtime_secs
    {
        return Some(entry.clone());
    }

    let bytes = Arc::new(fs::read(&disk_path).ok()?);
    let etag = format!("W/\"{size:x}-{mtime_secs:x}\"");
    let asset = CachedStaticAsset {
        bytes,
        content_type,
        content_encoding,
        etag,
        cache_control,
        mtime_secs,
        size,
    };

    if asset.bytes.len() <= STATIC_CACHE_MAX_ENTRY_BYTES
        && let Ok(mut cache) = state.static_cache.write()
    {
        if let Some(prev) = cache.entries.remove(&disk_path) {
            cache.total_bytes = cache.total_bytes.saturating_sub(prev.bytes.len());
        }
        if cache.total_bytes + asset.bytes.len() > STATIC_CACHE_MAX_TOTAL_BYTES {
            cache.entries.clear();
            cache.total_bytes = 0;
        }
        cache.total_bytes += asset.bytes.len();
        cache.entries.insert(disk_path, asset.clone());
    }

    Some(asset)
}

fn write_static_response(
    stream: &mut TcpStream,
    asset: &CachedStaticAsset,
    head_only: bool,
    if_none_match: Option<&str>,
    keep_alive: bool,
) -> io::Result<()> {
    let conn = if keep_alive { "keep-alive" } else { "close" };
    if let Some(inm) = if_none_match
        && inm.trim() == asset.etag
    {
        let resp = format!(
            "HTTP/1.1 304 Not Modified\r\nETag: {}\r\nCache-Control: {}\r\nConnection: {conn}\r\n\r\n",
            asset.etag, asset.cache_control
        );
        stream.write_all(resp.as_bytes())?;
        return stream.flush();
    }

    let encoding_header = match asset.content_encoding {
        Some(enc) => format!("Content-Encoding: {enc}\r\nVary: Accept-Encoding\r\n"),
        None => "Vary: Accept-Encoding\r\n".to_string(),
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nETag: {}\r\nCache-Control: {}\r\n{encoding_header}Connection: {conn}\r\n\r\n",
        asset.content_type,
        asset.bytes.len(),
        asset.etag,
        asset.cache_control
    );
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(&asset.bytes)?;
    }
    stream.flush()
}

fn prepare_upstream_head(head: &[u8], peer: Option<SocketAddr>, force_close: bool) -> Vec<u8> {
    let Some(end) = find_header_end(head) else {
        return head.to_vec();
    };
    let peer_ip = peer
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let mut out = Vec::with_capacity(head.len() + 128);
    if force_close && let Ok(header_text) = std::str::from_utf8(&head[..end - 4]) {
        for (idx, line) in header_text.split("\r\n").enumerate() {
            if idx > 0
                && let Some((name, _)) = line.split_once(':')
                && name.trim().eq_ignore_ascii_case("connection")
            {
                continue;
            }
            out.extend_from_slice(line.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(
            format!("Connection: close\r\nX-Forwarded-For: {peer_ip}\r\nX-J3-Relay: 1\r\n\r\n")
                .as_bytes(),
        );
    } else {
        out.extend_from_slice(&head[..end - 2]);
        out.extend_from_slice(
            format!("X-Forwarded-For: {peer_ip}\r\nX-J3-Relay: 1\r\n\r\n").as_bytes(),
        );
    }
    out.extend_from_slice(&head[end..]);
    out
}

fn connect_upstream(upstream: &str) -> io::Result<TcpStream> {
    let mut last_err = io::Error::new(io::ErrorKind::AddrNotAvailable, "no upstream address");
    for addr in upstream.to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, UPSTREAM_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

fn handle_client(mut client: TcpStream, peer: Option<SocketAddr>, state: Arc<SharedState>) {
    let _ = client.set_nodelay(true);
    let mut carry = Vec::<u8>::new();

    for req_index in 0..MAX_KEEP_ALIVE_REQUESTS {
        let timeout = if req_index == 0 {
            HEADER_READ_TIMEOUT
        } else {
            KEEP_ALIVE_TIMEOUT
        };
        let _ = client.set_read_timeout(Some(timeout));
        let _ = client.set_write_timeout(Some(HEADER_READ_TIMEOUT));

        let raw = match read_http_head(&mut client, &mut carry) {
            Ok(Some(bytes)) if !bytes.is_empty() => bytes,
            Ok(_) => return,
            Err(_) => {
                let _ = write_simple_response(
                    &mut client,
                    "431 Request Header Fields Too Large",
                    "application/json",
                    "{\"error\":\"header_too_large\"}",
                    false,
                );
                return;
            }
        };

        let Some(header_end) = find_header_end(&raw) else {
            let _ = write_simple_response(
                &mut client,
                "400 Bad Request",
                "application/json",
                "{\"error\":\"invalid_http_request\"}",
                false,
            );
            return;
        };

        let Some(parsed) = parse_request_head(&raw[..header_end]) else {
            let _ = write_simple_response(
                &mut client,
                "400 Bad Request",
                "application/json",
                "{\"error\":\"malformed_request_line\"}",
                false,
            );
            return;
        };

        // Never reuse a connection for local handlers when body framing headers are present
        // (prevents request smuggling if a body follows a GET/HEAD request).
        let local_keep_alive =
            parsed.keep_alive && !parsed.has_body_framing && req_index + 1 < MAX_KEEP_ALIVE_REQUESTS;

        if parsed.method == "GET"
            && (parsed.target == "/healthz" || parsed.target.starts_with("/healthz?"))
        {
            carry = if local_keep_alive {
                raw[header_end..].to_vec()
            } else {
                Vec::new()
            };
            let active = state.active_connections.load(Ordering::Relaxed);
            let body = format!(
                "{{\"ok\":true,\"service\":\"j3-relay-proxy\",\"version\":\"{}\",\"activeConnections\":{}}}",
                env!("CARGO_PKG_VERSION"),
                active
            );
            if write_simple_response(
                &mut client,
                "200 OK",
                "application/json",
                &body,
                local_keep_alive,
            )
            .is_err()
                || !local_keep_alive
            {
                return;
            }
            continue;
        }

        if let Some(expected) = state.config.auth_token.as_deref()
            && !is_authorized(expected, parsed.auth_header.as_deref())
        {
            let _ = write_simple_response(
                &mut client,
                "401 Unauthorized",
                "application/json",
                "{\"error\":\"unauthorized\"}",
                false,
            );
            return;
        }

        if let Some(static_root) = state.config.static_dir.as_deref()
            && (parsed.method == "GET" || parsed.method == "HEAD")
            && let Some(asset) =
                load_static_asset(&state, static_root, &parsed.target, parsed.accept_gzip)
        {
            carry = if local_keep_alive {
                raw[header_end..].to_vec()
            } else {
                Vec::new()
            };
            let head_only = parsed.method == "HEAD";
            if write_static_response(
                &mut client,
                &asset,
                head_only,
                parsed.if_none_match.as_deref(),
                local_keep_alive,
            )
            .is_err()
                || !local_keep_alive
            {
                return;
            }
            continue;
        }

        // Everything else (API, WebSocket upgrades, SPA fallback) tunnels to upstream.
        // Force `Connection: close` for non-upgrade HTTP requests so idle keep-alive sockets
        // do not hold tunnel threads and connection slots open for TUNNEL_IDLE_TIMEOUT.
        let mut upstream = match connect_upstream(&state.config.upstream) {
            Ok(stream) => stream,
            Err(_) => {
                let _ = write_simple_response(
                    &mut client,
                    "502 Bad Gateway",
                    "application/json",
                    "{\"error\":\"upstream_unreachable\"}",
                    false,
                );
                return;
            }
        };
        let _ = upstream.set_nodelay(true);
        let _ = upstream.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
        let _ = upstream.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));
        let _ = client.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
        let _ = client.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));

        let forwarded = prepare_upstream_head(&raw, peer, !parsed.is_upgrade);
        if upstream.write_all(&forwarded).is_err() || upstream.flush().is_err() {
            let _ = write_simple_response(
                &mut client,
                "502 Bad Gateway",
                "application/json",
                "{\"error\":\"upstream_write_failed\"}",
                false,
            );
            return;
        }

        let Ok(mut client_reader) = client.try_clone() else {
            return;
        };
        let Ok(mut upstream_writer) = upstream.try_clone() else {
            return;
        };

        let c2u = thread::Builder::new()
            .stack_size(WORKER_THREAD_STACK_BYTES)
            .spawn(move || {
                let _ = io::copy(&mut client_reader, &mut upstream_writer);
                let _ = upstream_writer.shutdown(Shutdown::Write);
            });

        let _ = io::copy(&mut upstream, &mut client);
        let _ = client.shutdown(Shutdown::Write);
        if let Ok(handle) = c2u {
            let _ = handle.join();
        }
        return;
    }
}

fn serve(listener: TcpListener, state: Arc<SharedState>) -> io::Result<()> {
    // Blocking accept avoids 10ms busy polling so idle CPU usage stays near zero.
    loop {
        let (mut stream, peer) = match listener.accept() {
            Ok(pair) => pair,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if state.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        let prev = state.active_connections.fetch_add(1, Ordering::SeqCst);
        if prev >= state.config.max_connections {
            state.active_connections.fetch_sub(1, Ordering::SeqCst);
            let _ = write_simple_response(
                &mut stream,
                "503 Service Unavailable",
                "application/json",
                "{\"error\":\"too_many_connections\"}",
                false,
            );
            continue;
        }
        let guard = ConnectionGuard {
            state: Arc::clone(&state),
        };
        let worker_state = Arc::clone(&state);
        if let Err(err) = thread::Builder::new()
            .stack_size(WORKER_THREAD_STACK_BYTES)
            .spawn(move || {
                let _guard = guard;
                handle_client(stream, Some(peer), worker_state);
            })
        {
            eprintln!("failed to spawn relay worker thread: {err}");
        }
    }
}

fn main() {
    let config = match ProxyConfig::from_args_and_env() {
        Ok(cfg) => cfg,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };

    let listener = match TcpListener::bind(&config.listen) {
        Ok(l) => l,
        Err(err) => {
            eprintln!("failed to bind {}: {err}", config.listen);
            std::process::exit(1);
        }
    };

    let bound_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| config.listen.clone());
    println!(
        "j3-relay-proxy listening on http://{bound_addr} -> {} (max_connections={}, auth={}, static={})",
        config.upstream,
        config.max_connections,
        if config.auth_token.is_some() {
            "bearer"
        } else {
            "none"
        },
        config
            .static_dir
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "off".to_string())
    );

    let state = Arc::new(SharedState {
        config,
        active_connections: AtomicUsize::new(0),
        shutdown: AtomicBool::new(false),
        static_cache: RwLock::new(StaticCache::new()),
    });

    if let Err(err) = serve(listener, state) {
        eprintln!("relay proxy stopped with error: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn start_test_proxy(
        upstream: String,
        auth_token: Option<String>,
        max_connections: usize,
        static_dir: Option<PathBuf>,
    ) -> (SocketAddr, Arc<SharedState>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(SharedState {
            config: ProxyConfig {
                listen: addr.to_string(),
                upstream,
                auth_token,
                max_connections,
                static_dir,
            },
            active_connections: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            static_cache: RwLock::new(StaticCache::new()),
        });
        let worker_state = Arc::clone(&state);
        let handle = thread::spawn(move || {
            let _ = serve(listener, worker_state);
        });
        (addr, state, handle)
    }

    fn stop_test_proxy(addr: SocketAddr, state: &Arc<SharedState>, handle: thread::JoinHandle<()>) {
        state.shutdown.store(true, Ordering::Relaxed);
        // Wake the blocking accept() cleanly with a dummy connection.
        let _ = TcpStream::connect(addr);
        let _ = handle.join();
    }

    #[test]
    fn healthz_and_bearer_auth_and_http_proxy_work() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            if let Ok((mut stream, _)) = upstream_listener.accept() {
                let mut carry = Vec::new();
                let req = read_http_head(&mut stream, &mut carry).unwrap().unwrap();
                let req_str = String::from_utf8_lossy(&req);
                assert!(req_str.contains("GET /api/ping HTTP/1.1"));
                assert!(req_str.contains("X-J3-Relay: 1"));
                // Non-upgrade HTTP requests receive `Connection: close` to prevent idle slot leaks.
                assert!(req_str.contains("Connection: close"));
                let _ = write_simple_response(&mut stream, "200 OK", "text/plain", "pong", false);
            }
        });

        let (proxy_addr, state, proxy_thread) = start_test_proxy(
            upstream_addr.to_string(),
            Some("secret-relay-key".to_string()),
            16,
            None,
        );

        // 1. /healthz succeeds without auth (including keep-alive reuse)
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\nGET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert_eq!(resp.matches("200 OK").count(), 2);
            assert!(resp.contains("\"service\":\"j3-relay-proxy\""));
        }

        // 2. Body-framed GET refuses keep-alive to prevent request smuggling
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nGET /",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert_eq!(resp.matches("200 OK").count(), 1);
            assert!(resp.contains("Connection: close"));
        }

        // 3. Unauthorized request is rejected with 401
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(b"GET /api/ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("401 Unauthorized"));
        }

        // 4. Authorized request proxies to upstream and returns response
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /api/ping HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret-relay-key\r\nConnection: keep-alive\r\n\r\n",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("200 OK"));
            assert!(resp.ends_with("pong"));
        }

        stop_test_proxy(proxy_addr, &state, proxy_thread);
        let _ = upstream_thread.join();
    }

    #[test]
    fn serves_static_assets_with_etag_gzip_percent_decode_and_blocks_traversal() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("j3-relay-static-{nanos}"));
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/app.js"), "console.log('j3');").unwrap();
        fs::write(dir.join("assets/app.js.gz"), b"FAKE_GZIP_BYTES").unwrap();
        fs::write(dir.join("assets/my file.txt"), "hello space").unwrap();
        let canon_dir = fs::canonicalize(&dir).unwrap();

        let (proxy_addr, state, proxy_thread) =
            start_test_proxy("127.0.0.1:1".to_string(), None, 16, Some(canon_dir));

        // 1. Plain static fetch returns 200 + ETag + immutable Cache-Control
        let etag = {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /assets/app.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("200 OK"));
            assert!(resp.contains("application/javascript"));
            assert!(resp.contains("immutable"));
            assert!(resp.ends_with("console.log('j3');"));
            resp.lines()
                .find_map(|l| l.strip_prefix("ETag: "))
                .unwrap()
                .trim()
                .to_string()
        };

        // 2. Percent-encoded path (%20) resolves cleanly
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /assets/my%20file.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("200 OK"));
            assert!(resp.ends_with("hello space"));
        }

        // 3. Matching If-None-Match returns 304 Not Modified
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            let req = format!(
                "GET /assets/app.js HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: {etag}\r\nConnection: close\r\n\r\n"
            );
            conn.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("304 Not Modified"));
        }

        // 4. Accept-Encoding: gzip serves pre-compressed .gz sibling
        {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            conn.write_all(
                b"GET /assets/app.js HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("200 OK"));
            assert!(resp.contains("Content-Encoding: gzip"));
            assert!(resp.ends_with("FAKE_GZIP_BYTES"));
        }

        // 5. Encoded and plain path traversal are rejected from static dir (-> 502 unreachable upstream)
        for bad_path in ["/../secret.txt", "/%2e%2e/secret.txt"] {
            let mut conn = TcpStream::connect(proxy_addr).unwrap();
            let req = format!("GET {bad_path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            conn.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            conn.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("502 Bad Gateway"));
        }

        stop_test_proxy(proxy_addr, &state, proxy_thread);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relays_bidirectional_websocket_upgrade_tunnel() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            if let Ok((mut stream, _)) = upstream_listener.accept() {
                let mut carry = Vec::new();
                let req = read_http_head(&mut stream, &mut carry).unwrap().unwrap();
                let req_str = String::from_utf8_lossy(&req);
                assert!(req_str.contains("Upgrade: websocket"));
                assert!(req_str.contains("Connection: Upgrade"));
                stream
                    .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                    .unwrap();
                stream.flush().unwrap();

                let mut payload = [0u8; 5];
                stream.read_exact(&mut payload).unwrap();
                assert_eq!(&payload, b"hello");
                stream.write_all(b"world").unwrap();
                stream.flush().unwrap();
            }
        });

        let (proxy_addr, state, proxy_thread) =
            start_test_proxy(upstream_addr.to_string(), None, 16, None);

        let mut conn = TcpStream::connect(proxy_addr).unwrap();
        conn.write_all(
            b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        )
        .unwrap();
        conn.flush().unwrap();

        let mut carry = Vec::new();
        let head = read_http_head(&mut conn, &mut carry).unwrap().unwrap();
        assert!(String::from_utf8_lossy(&head).contains("101 Switching Protocols"));

        conn.write_all(b"hello").unwrap();
        conn.flush().unwrap();
        let mut reply = [0u8; 5];
        conn.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"world");
        drop(conn);

        stop_test_proxy(proxy_addr, &state, proxy_thread);
        let _ = upstream_thread.join();
    }
}
