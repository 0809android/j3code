use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use memchr::{memchr, memchr_iter};
use regex::bytes::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 400;
const BINARY_PROBE_BYTES: usize = 8192;
const MAX_WALK_THREADS: usize = 6;

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
enum Request {
    Files {
        cwd: String,
        #[serde(default)]
        query: String,
        #[serde(default = "default_files_limit")]
        limit: usize,
        #[serde(rename = "includeHidden", default)]
        include_hidden: bool,
    },
    Grep {
        cwd: String,
        query: String,
        #[serde(rename = "caseSensitive", default)]
        case_sensitive: bool,
        #[serde(rename = "useRegex", default)]
        use_regex: bool,
        #[serde(rename = "wholeWord", default)]
        whole_word: bool,
        #[serde(default = "default_grep_limit")]
        limit: usize,
        #[serde(rename = "maxPerFile", default = "default_max_per_file")]
        max_per_file: usize,
    },
    DiffStat {
        diff: String,
    },
    CheckIgnore {
        cwd: String,
        paths: Vec<CheckIgnoreEntry>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckIgnoreEntry {
    path: String,
    #[serde(default)]
    is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckIgnoreResponse {
    ignored: Vec<String>,
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct ServeEnvelope {
    id: String,
    #[serde(flatten)]
    request: Request,
}

#[derive(Debug, Serialize)]
struct ServeResponse<'a, T: Serialize> {
    id: &'a str,
    result: T,
}

fn default_files_limit() -> usize {
    100
}

fn default_grep_limit() -> usize {
    100
}

fn default_max_per_file() -> usize {
    20
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    path: String,
    kind: &'static str,
    score: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesResponse {
    entries: Vec<FileEntry>,
    truncated: bool,
    scanned_files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrepMatch {
    path: String,
    line: usize,
    column: usize,
    match_len: usize,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrepResponse {
    matches: Vec<GrepMatch>,
    truncated: bool,
    searched_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DiffFileStat {
    path: String,
    additions: usize,
    deletions: usize,
    hunks: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffStatResponse {
    files: Vec<DiffFileStat>,
    total_additions: usize,
    total_deletions: usize,
}

fn to_posix_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        let text = component.as_os_str().to_str()?;
        if !text.is_empty() {
            parts.push(text);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn score_path_match(path: &str, query_lower: &str) -> Option<i32> {
    if query_lower.is_empty() {
        return Some(0);
    }
    let lower = path.to_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    if basename == query_lower {
        return Some(1000);
    }
    if basename.starts_with(query_lower) {
        return Some(800 - basename.len() as i32);
    }
    if lower == query_lower {
        return Some(900);
    }
    if let Some(pos) = basename.find(query_lower) {
        return Some(600 - pos as i32 - basename.len() as i32);
    }
    if let Some(pos) = lower.find(query_lower) {
        return Some(400 - pos as i32 - lower.len() as i32 / 4);
    }

    let mut query_chars = query_lower.chars().peekable();
    let mut consecutive = 0i32;
    let mut bonus = 0i32;
    for ch in lower.chars() {
        if query_chars.peek() == Some(&ch) {
            query_chars.next();
            consecutive += 1;
            bonus += consecutive * 4;
        } else {
            consecutive = 0;
        }
    }
    if query_chars.peek().is_none() {
        Some(100 + bonus - lower.len() as i32 / 2)
    } else {
        None
    }
}

fn build_walker(root: &Path, include_hidden: bool) -> WalkBuilder {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, MAX_WALK_THREADS))
        .unwrap_or(4);
    let mut builder = WalkBuilder::new(root);
    builder
        .threads(threads)
        .hidden(!include_hidden)
        .follow_links(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git" && name != "node_modules" && name != "target"
        });
    builder
}

fn run_files(cwd: &str, query: &str, limit: usize, include_hidden: bool) -> FilesResponse {
    let Ok(root) = fs::canonicalize(cwd) else {
        return FilesResponse {
            entries: Vec::new(),
            truncated: false,
            scanned_files: 0,
        };
    };

    let query_lower = query.trim().to_lowercase();
    let capped_limit = limit.clamp(1, 2000);
    let results = Arc::new(Mutex::new(Vec::<FileEntry>::new()));
    let scanned = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    build_walker(&root, include_hidden)
        .build_parallel()
        .run(|| {
            let root = root.clone();
            let query_lower = query_lower.clone();
            let results = Arc::clone(&results);
            let scanned = Arc::clone(&scanned);
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return ignore::WalkState::Continue;
                };
                if entry.depth() == 0 {
                    return ignore::WalkState::Continue;
                }
                let Some(ft) = entry.file_type() else {
                    return ignore::WalkState::Continue;
                };
                if !ft.is_file() && !ft.is_dir() {
                    return ignore::WalkState::Continue;
                }
                let Some(rel) = to_posix_relative(&root, entry.path()) else {
                    return ignore::WalkState::Continue;
                };
                scanned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if let Some(score) = score_path_match(&rel, &query_lower) {
                    let kind = if ft.is_dir() { "directory" } else { "file" };
                    if let Ok(mut guard) = results.lock() {
                        guard.push(FileEntry {
                            path: rel,
                            kind,
                            score,
                        });
                    }
                }
                ignore::WalkState::Continue
            })
        });

    let mut entries = Arc::try_unwrap(results)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default();
    entries.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    let truncated = entries.len() > capped_limit;
    entries.truncate(capped_limit);

    FilesResponse {
        entries,
        truncated,
        scanned_files: scanned.load(std::sync::atomic::Ordering::Relaxed),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    let probe_len = bytes.len().min(BINARY_PROBE_BYTES);
    memchr(0, &bytes[..probe_len]).is_some()
}

fn extract_matches_from_bytes(
    bytes: &[u8],
    rel: &str,
    regex: &regex::bytes::Regex,
    per_file_cap: usize,
) -> Vec<GrepMatch> {
    let mut local_matches = Vec::new();
    let mut line_num = 1usize;
    let mut cursor = 0usize;

    // Fast whole-file pre-check: 99%+ of files skip line scanning and UTF-8 decoding entirely.
    if !regex.is_match(bytes) {
        return local_matches;
    }

    for nl_pos in memchr_iter(b'\n', bytes) {
        let mut line_bytes = &bytes[cursor..nl_pos];
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }
        if let Some(m) = regex.find(line_bytes) {
            let line_str = String::from_utf8_lossy(line_bytes);
            let col = String::from_utf8_lossy(&line_bytes[..m.start()]).chars().count() + 1;
            let match_len = String::from_utf8_lossy(&line_bytes[m.start()..m.end()])
                .chars()
                .count()
                .max(1);
            local_matches.push(GrepMatch {
                path: rel.to_string(),
                line: line_num,
                column: col,
                match_len,
                text: truncate_chars(&line_str, MAX_LINE_CHARS),
            });
            if local_matches.len() >= per_file_cap {
                return local_matches;
            }
        }
        cursor = nl_pos + 1;
        line_num += 1;
    }

    if cursor < bytes.len() && local_matches.len() < per_file_cap {
        let mut line_bytes = &bytes[cursor..];
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }
        if let Some(m) = regex.find(line_bytes) {
            let line_str = String::from_utf8_lossy(line_bytes);
            let col = String::from_utf8_lossy(&line_bytes[..m.start()]).chars().count() + 1;
            let match_len = String::from_utf8_lossy(&line_bytes[m.start()..m.end()])
                .chars()
                .count()
                .max(1);
            local_matches.push(GrepMatch {
                path: rel.to_string(),
                line: line_num,
                column: col,
                match_len,
                text: truncate_chars(&line_str, MAX_LINE_CHARS),
            });
        }
    }

    local_matches
}

fn run_grep(
    cwd: &str,
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    limit: usize,
    max_per_file: usize,
) -> GrepResponse {
    if query.is_empty() {
        return GrepResponse {
            matches: Vec::new(),
            truncated: false,
            searched_files: 0,
            error: Some("Query must not be empty.".to_string()),
        };
    }

    let Ok(root) = fs::canonicalize(cwd) else {
        return GrepResponse {
            matches: Vec::new(),
            truncated: false,
            searched_files: 0,
            error: Some("Workspace directory does not exist.".to_string()),
        };
    };

    let base_pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let full_pattern = if whole_word {
        format!(r"\b(?:{base_pattern})\b")
    } else {
        base_pattern
    };
    // Keep Unicode folding off for pure-ASCII literal queries so regex::bytes uses SIMD prefilters.
    let enable_unicode = use_regex || !query.is_ascii();
    let regex = match RegexBuilder::new(&full_pattern)
        .case_insensitive(!case_sensitive)
        .unicode(enable_unicode)
        .size_limit(10 * 1024 * 1024)
        .build()
    {
        Ok(re) => Arc::new(re),
        Err(err) => {
            return GrepResponse {
                matches: Vec::new(),
                truncated: false,
                searched_files: 0,
                error: Some(format!("Invalid search pattern: {err}")),
            };
        }
    };

    let capped_limit = limit.clamp(1, 2000);
    let per_file_cap = max_per_file.clamp(1, 200);
    let collected = Arc::new(Mutex::new(Vec::<GrepMatch>::new()));
    let truncated = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let searched_files = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    build_walker(&root, false).build_parallel().run(|| {
        let root = root.clone();
        let regex = Arc::clone(&regex);
        let collected = Arc::clone(&collected);
        let truncated = Arc::clone(&truncated);
        let searched_files = Arc::clone(&searched_files);
        let mut scratch = Vec::<u8>::with_capacity(64 * 1024);

        Box::new(move |entry| {
            if truncated.load(std::sync::atomic::Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }
            let Ok(meta) = entry.metadata() else {
                return ignore::WalkState::Continue;
            };
            if meta.len() == 0 || meta.len() > MAX_GREP_FILE_BYTES {
                return ignore::WalkState::Continue;
            }
            let Some(rel) = to_posix_relative(&root, entry.path()) else {
                return ignore::WalkState::Continue;
            };

            scratch.clear();
            let Ok(mut file) = File::open(entry.path()) else {
                return ignore::WalkState::Continue;
            };
            if file.read_to_end(&mut scratch).is_err() || is_probably_binary(&scratch) {
                return ignore::WalkState::Continue;
            }
            searched_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let local_matches = extract_matches_from_bytes(&scratch, &rel, &regex, per_file_cap);
            if !local_matches.is_empty()
                && let Ok(mut guard) = collected.lock()
            {
                for item in local_matches {
                    if guard.len() >= capped_limit {
                        truncated.store(true, std::sync::atomic::Ordering::Relaxed);
                        return ignore::WalkState::Quit;
                    }
                    guard.push(item);
                }
            }

            ignore::WalkState::Continue
        })
    });

    let mut matches = Arc::try_unwrap(collected)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default();
    matches.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.line.cmp(&b.line)));

    GrepResponse {
        matches,
        truncated: truncated.load(std::sync::atomic::Ordering::Relaxed),
        searched_files: searched_files.load(std::sync::atomic::Ordering::Relaxed),
        error: None,
    }
}

fn run_diff_stat(diff: &str) -> DiffStatResponse {
    let mut files: Vec<DiffFileStat> = Vec::new();
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest
                .split(" b/")
                .nth(1)
                .unwrap_or(rest)
                .trim_matches('"')
                .to_string();
            files.push(DiffFileStat {
                path,
                additions: 0,
                deletions: 0,
                hunks: 0,
            });
            continue;
        }
        let Some(current) = files.last_mut() else {
            continue;
        };
        if line.starts_with("@@ ") {
            current.hunks += 1;
        } else if line.starts_with('+') && !line.starts_with("+++ ") {
            current.additions += 1;
            total_additions += 1;
        } else if line.starts_with('-') && !line.starts_with("--- ") {
            current.deletions += 1;
            total_deletions += 1;
        }
    }

    DiffStatResponse {
        files,
        total_additions,
        total_deletions,
    }
}

#[derive(Clone)]
struct CachedGitIndex {
    mtime_nanos: u128,
    size: u64,
    tracked_files: Arc<HashSet<String>>,
    tracked_dirs: Arc<HashSet<String>>,
}

fn git_index_cache() -> &'static Mutex<HashMap<PathBuf, CachedGitIndex>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedGitIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        let content = fs::read_to_string(&dot_git).ok()?;
        let line = content.lines().next()?.trim();
        let raw = line.strip_prefix("gitdir:")?.trim();
        let target = PathBuf::from(raw);
        let resolved = if target.is_absolute() {
            target
        } else {
            repo_root.join(target)
        };
        return fs::canonicalize(resolved).ok();
    }
    None
}

/// Parses Git's binary index (versions 2 and 3) to identify tracked files and their parent
/// directories so `check-ignore` matches `git check-ignore` (tracked paths are never ignored).
/// Returns `None` for unsupported formats (v4, split-index, corrupt) so callers fall back to git.
fn normalize_tracked_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn global_gitignore() -> Option<&'static Gitignore> {
    static GLOBAL: OnceLock<Option<Gitignore>> = OnceLock::new();
    GLOBAL
        .get_or_init(|| {
            let (gi, _err) = Gitignore::global();
            if gi.is_empty() { None } else { Some(gi) }
        })
        .as_ref()
}

fn load_tracked_paths(git_dir: &Path) -> Option<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
    let index_path = git_dir.join("index");
    let meta = match fs::metadata(&index_path) {
        Ok(m) => m,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Some((Arc::new(HashSet::new()), Arc::new(HashSet::new())));
        }
        Err(_) => return None,
    };
    let size = meta.len();
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    if let Ok(cache) = git_index_cache().lock()
        && let Some(entry) = cache.get(&index_path)
        && entry.size == size
        && entry.mtime_nanos == mtime_nanos
    {
        return Some((Arc::clone(&entry.tracked_files), Arc::clone(&entry.tracked_dirs)));
    }

    let bytes = fs::read(&index_path).ok()?;
    if bytes.len() < 12 || &bytes[0..4] != b"DIRC" {
        return None;
    }
    let version = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    if version != 2 && version != 3 {
        return None;
    }
    let count = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let mut tracked_files = HashSet::with_capacity(count);
    let mut tracked_dirs = HashSet::new();

    let mut pos = 12usize;
    for _ in 0..count {
        if pos + 62 > bytes.len() {
            return None;
        }
        let flags = u16::from_be_bytes([bytes[pos + 60], bytes[pos + 61]]);
        let name_start = if version == 3 && (flags & 0x4000) != 0 {
            64usize
        } else {
            62usize
        };
        if pos + name_start >= bytes.len() {
            return None;
        }
        let nul_offset = memchr(0, &bytes[pos + name_start..])?;
        let name_bytes = &bytes[pos + name_start..pos + name_start + nul_offset];
        let path_str = std::str::from_utf8(name_bytes).ok()?;
        let normalized = normalize_tracked_key(path_str);
        tracked_files.insert(normalized.clone());
        let mut slash = normalized.rfind('/');
        while let Some(idx) = slash {
            let dir = &normalized[..idx];
            if !tracked_dirs.insert(dir.to_string()) {
                break;
            }
            slash = dir.rfind('/');
        }
        // Entry length is padded with 1..=8 NUL bytes to an 8-byte boundary.
        let entry_len = (name_start + nul_offset + 8) & !7;
        pos += entry_len;
    }

    // Check for split-index ('link') extension after entries; fall back to git if present.
    while pos + 8 <= bytes.len().saturating_sub(20) {
        let sig = &bytes[pos..pos + 4];
        if sig == b"link" {
            return None;
        }
        let ext_len = u32::from_be_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        pos = pos.checked_add(8)?.checked_add(ext_len)?;
    }

    let files_arc = Arc::new(tracked_files);
    let dirs_arc = Arc::new(tracked_dirs);
    if let Ok(mut cache) = git_index_cache().lock() {
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(
            index_path,
            CachedGitIndex {
                mtime_nanos,
                size,
                tracked_files: Arc::clone(&files_arc),
                tracked_dirs: Arc::clone(&dirs_arc),
            },
        );
    }
    Some((files_arc, dirs_arc))
}

fn run_check_ignore(cwd: &str, paths: &[CheckIgnoreEntry]) -> CheckIgnoreResponse {
    let Ok(root) = fs::canonicalize(cwd) else {
        return CheckIgnoreResponse {
            ignored: Vec::new(),
            ok: false,
        };
    };
    // Require a .git directory/file at or above root so we match `git check-ignore` semantics.
    let mut git_root: Option<PathBuf> = None;
    let mut cursor = Some(root.as_path());
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            git_root = Some(dir.to_path_buf());
            break;
        }
        cursor = dir.parent();
    }
    let Some(repo_root) = git_root else {
        return CheckIgnoreResponse {
            ignored: Vec::new(),
            ok: true,
        };
    };
    let Some(git_dir) = resolve_git_dir(&repo_root) else {
        return CheckIgnoreResponse {
            ignored: Vec::new(),
            ok: false,
        };
    };
    let Some((tracked_files, tracked_dirs)) = load_tracked_paths(&git_dir) else {
        return CheckIgnoreResponse {
            ignored: Vec::new(),
            ok: false,
        };
    };

    // Collect ancestor directories from repo_root down to each queried entry's parent directory
    // so nested .gitignore files are loaded in Git's precedence order (shallow -> deep).
    let mut ignore_dirs: Vec<PathBuf> = Vec::new();
    let mut seen_dirs = HashSet::<PathBuf>::new();

    let mut add_chain = |target_dir: &Path| {
        let mut chain = Vec::new();
        let mut cur = Some(target_dir);
        while let Some(d) = cur {
            if !d.starts_with(&repo_root) {
                break;
            }
            chain.push(d.to_path_buf());
            if d == repo_root {
                break;
            }
            cur = d.parent();
        }
        chain.reverse();
        for dir in chain {
            if seen_dirs.insert(dir.clone()) {
                ignore_dirs.push(dir);
            }
        }
    };

    add_chain(&root);
    for entry in paths {
        let full = root.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = full.parent() {
            add_chain(parent);
        }
    }

    // Build per-directory matchers so each .gitignore applies relative to its own directory.
    let mut matchers = Vec::new();
    // 1. .git/info/exclude (lowest precedence after global, applied at repo_root)
    let exclude_file = git_dir.join("info").join("exclude");
    if exclude_file.is_file() {
        let mut b = GitignoreBuilder::new(&repo_root);
        let _ = b.add(&exclude_file);
        if let Ok(gi) = b.build() {
            matchers.push((repo_root.clone(), gi));
        }
    }
    // 2. .gitignore files from shallowest to deepest
    for dir in &ignore_dirs {
        let gi_file = dir.join(".gitignore");
        if gi_file.is_file() {
            let mut b = GitignoreBuilder::new(dir);
            let _ = b.add(&gi_file);
            if let Ok(gi) = b.build() {
                matchers.push((dir.clone(), gi));
            }
        }
    }

    let mut ignored = Vec::new();
    let global_gi = global_gitignore();
    for entry in paths {
        let full = root.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(repo_rel) = to_posix_relative(&repo_root, &full) {
            let key = normalize_tracked_key(&repo_rel);
            if entry.is_dir {
                if tracked_dirs.contains(&key) {
                    continue;
                }
            } else if tracked_files.contains(&key) {
                continue;
            }
        }
        let mut decision: Option<bool> = None;
        if let Some(gi) = global_gi {
            match gi.matched_path_or_any_parents(&full, entry.is_dir) {
                ignore::Match::Ignore(_) => decision = Some(true),
                ignore::Match::Whitelist(_) => decision = Some(false),
                ignore::Match::None => {}
            }
        }
        for (base, gi) in &matchers {
            if !full.starts_with(base) {
                continue;
            }
            match gi.matched_path_or_any_parents(&full, entry.is_dir) {
                ignore::Match::Ignore(_) => decision = Some(true),
                ignore::Match::Whitelist(_) => decision = Some(false),
                ignore::Match::None => {}
            }
        }
        if decision == Some(true) {
            ignored.push(entry.path.clone());
        }
    }

    CheckIgnoreResponse { ignored, ok: true }
}

fn handle_request(request: Request) -> serde_json::Result<String> {
    match request {
        Request::Files {
            cwd,
            query,
            limit,
            include_hidden,
        } => serde_json::to_string(&run_files(&cwd, &query, limit, include_hidden)),
        Request::Grep {
            cwd,
            query,
            case_sensitive,
            use_regex,
            whole_word,
            limit,
            max_per_file,
        } => serde_json::to_string(&run_grep(
            &cwd,
            &query,
            case_sensitive,
            use_regex,
            whole_word,
            limit,
            max_per_file,
        )),
        Request::DiffStat { diff } => serde_json::to_string(&run_diff_stat(&diff)),
        Request::CheckIgnore { cwd, paths } => serde_json::to_string(&run_check_ignore(&cwd, &paths)),
    }
}

fn run_serve() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<ServeEnvelope>(trimmed) else {
            continue;
        };
        let response = match envelope.request {
            Request::Files {
                cwd,
                query,
                limit,
                include_hidden,
            } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_files(&cwd, &query, limit, include_hidden),
            }),
            Request::Grep {
                cwd,
                query,
                case_sensitive,
                use_regex,
                whole_word,
                limit,
                max_per_file,
            } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_grep(
                    &cwd,
                    &query,
                    case_sensitive,
                    use_regex,
                    whole_word,
                    limit,
                    max_per_file,
                ),
            }),
            Request::DiffStat { diff } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_diff_stat(&diff),
            }),
            Request::CheckIgnore { cwd, paths } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_check_ignore(&cwd, &paths),
            }),
        };
        if let Ok(json) = response {
            if writer.write_all(json.as_bytes()).is_err()
                || writer.write_all(b"\n").is_err()
                || writer.flush().is_err()
            {
                break;
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--serve") {
        run_serve();
        return;
    }

    let mut input = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {err}");
        std::process::exit(2);
    }

    let request: Request = match serde_json::from_str(&input) {
        Ok(req) => req,
        Err(err) => {
            eprintln!("invalid JSON request: {err}");
            std::process::exit(2);
        }
    };

    match handle_request(request) {
        Ok(json) => println!("{json}"),
        Err(err) => {
            eprintln!("failed to serialize output: {err}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_repo(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("j3-ws-search-{label}-{nanos}"));
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn respects_gitignore_and_ranks_matching_files() {
        let dir = make_temp_repo("files");
        fs::write(dir.join(".gitignore"), "ignored.log\n").unwrap();
        fs::write(dir.join("ignored.log"), "secret").unwrap();
        fs::write(dir.join("src/fallback.ts"), "export const x = 1;\n").unwrap();
        fs::write(dir.join("src/other.ts"), "export const y = 2;\n").unwrap();

        let res = run_files(dir.to_str().unwrap(), "fallback", 10, false);
        assert_eq!(res.entries.len(), 1);
        assert_eq!(res.entries[0].path, "src/fallback.ts");

        let all = run_files(dir.to_str().unwrap(), "", 20, false);
        assert!(!all.entries.iter().any(|e| e.path == "ignored.log"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn greps_text_files_and_skips_binaries() {
        let dir = make_temp_repo("grep");
        fs::write(
            dir.join("src/app.ts"),
            "const greeting = 'Hello J3 Code';\nconst other = 1;\n",
        )
        .unwrap();
        fs::write(dir.join("src/blob.bin"), [0u8, 1, 2, b'J', b'3', 0]).unwrap();

        let res = run_grep(dir.to_str().unwrap(), "j3 code", false, false, false, 20, 10);
        assert_eq!(res.error, None);
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].path, "src/app.ts");
        assert_eq!(res.matches[0].line, 1);

        let whole = run_grep(dir.to_str().unwrap(), "greet", false, false, true, 20, 10);
        assert_eq!(whole.matches.len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_unified_diff_stats() {
        let sample = "\
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
";
        let stat = run_diff_stat(sample);
        assert_eq!(stat.total_additions, 2);
        assert_eq!(stat.total_deletions, 1);
        assert_eq!(
            stat.files,
            vec![DiffFileStat {
                path: "src/a.ts".to_string(),
                additions: 2,
                deletions: 1,
                hunks: 1
            }]
        );
    }

    #[test]
    fn checks_gitignore_rules_including_negations_and_nested_files() {
        let dir = make_temp_repo("check-ignore");
        fs::write(dir.join(".gitignore"), "*.log\n!keep.log\ndist/\n").unwrap();
        fs::write(dir.join("src/.gitignore"), "generated.ts\n").unwrap();

        let res = run_check_ignore(
            dir.to_str().unwrap(),
            &[
                CheckIgnoreEntry {
                    path: "debug.log".to_string(),
                    is_dir: false,
                },
                CheckIgnoreEntry {
                    path: "keep.log".to_string(),
                    is_dir: false,
                },
                CheckIgnoreEntry {
                    path: "dist".to_string(),
                    is_dir: true,
                },
                CheckIgnoreEntry {
                    path: "src/generated.ts".to_string(),
                    is_dir: false,
                },
                CheckIgnoreEntry {
                    path: "src/app.ts".to_string(),
                    is_dir: false,
                },
            ],
        );
        assert!(res.ok);
        assert_eq!(
            res.ignored,
            vec![
                "debug.log".to_string(),
                "dist".to_string(),
                "src/generated.ts".to_string()
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
