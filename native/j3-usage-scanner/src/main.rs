use memchr::{memchr, memmem};
use rayon::prelude::*;
use ruzstd::decoding::StreamingDecoder;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

const GUARD_LENGTH: usize = 64;
const READ_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
enum Request {
    List {
        root: String,
        #[serde(rename = "sinceMs")]
        since_ms: f64,
        #[serde(rename = "fileName", default)]
        file_name: Option<String>,
    },
    FilterLines {
        path: String,
        markers: Vec<String>,
        #[serde(rename = "resumeOffset", default)]
        resume_offset: u64,
        #[serde(rename = "guardLength", default)]
        guard_length: usize,
        #[serde(rename = "guardHash", default)]
        guard_hash: u32,
        #[serde(rename = "maxLineBytes", default)]
        max_line_bytes: Option<usize>,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TranscriptFile {
    path: String,
    size: u64,
    mtime_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    files: Vec<TranscriptFile>,
    walked: Vec<String>,
    failed_paths: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilterLinesResponse {
    ok: bool,
    resumed: bool,
    resume_offset: u64,
    guard_length: usize,
    guard_hash: u32,
    matched_lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail_line: Option<String>,
    oversized_skipped: usize,
}

/// FNV-1a 32-bit hash matching apps/server/src/usage/usageTranscriptReader.ts.
fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn collect_candidates(
    dir: &Path,
    file_name: Option<&str>,
    failed_paths: &AtomicUsize,
) -> Vec<PathBuf> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            return Vec::new();
        }
    };

    let mut subdirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            subdirs.push(path);
        } else if let Some(name) = entry.file_name().to_str() {
            let matched = match file_name {
                Some(expected) => name == expected,
                None => name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"),
            };
            if matched {
                files.push(path);
            }
        }
    }

    if !subdirs.is_empty() {
        let nested: Vec<Vec<PathBuf>> = subdirs
            .par_iter()
            .map(|sub| collect_candidates(sub, file_name, failed_paths))
            .collect();
        for mut list in nested {
            files.append(&mut list);
        }
    }

    files
}

fn run_list(root: &Path, since_ms: f64, file_name: Option<&str>) -> ListResponse {
    let failed_paths = AtomicUsize::new(0);
    // Preserve readdir traversal order to match usageTranscriptReader.ts first-seen deduplication.
    let candidates = collect_candidates(root, file_name, &failed_paths);

    let walked: Vec<String> = candidates
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let stat_results: Vec<Option<TranscriptFile>> = candidates
        .par_iter()
        .map(|path| match fs::metadata(path) {
            Ok(meta) => {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|dur| dur.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                if mtime_ms >= since_ms {
                    Some(TranscriptFile {
                        path: path.to_string_lossy().into_owned(),
                        size: meta.len(),
                        mtime_ms,
                    })
                } else {
                    None
                }
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    failed_paths.fetch_add(1, Ordering::Relaxed);
                }
                None
            }
        })
        .collect();

    let files = stat_results.into_iter().flatten().collect();
    ListResponse {
        files,
        walked,
        failed_paths: failed_paths.load(Ordering::Relaxed),
    }
}

fn guard_matches(file: &mut File, resume_offset: u64, guard_length: usize, guard_hash: u32) -> bool {
    if guard_length == 0 || guard_length > GUARD_LENGTH || resume_offset < guard_length as u64 {
        return false;
    }
    let start = resume_offset - guard_length as u64;
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = vec![0u8; guard_length];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    fnv1a(&buf) == guard_hash
}

fn line_matches_any(line: &[u8], finders: &[memmem::Finder<'_>]) -> bool {
    if finders.is_empty() {
        return true;
    }
    finders.iter().any(|finder| finder.find(line).is_some())
}

fn trim_cr(line: &[u8]) -> &[u8] {
    if line.last() == Some(&b'\r') {
        &line[..line.len() - 1]
    } else {
        line
    }
}

fn run_filter_lines(
    path: &Path,
    markers: &[String],
    resume_offset_in: u64,
    guard_length_in: usize,
    guard_hash_in: u32,
    max_line_bytes: Option<usize>,
) -> FilterLinesResponse {
    let empty_fail = || FilterLinesResponse {
        ok: false,
        resumed: false,
        resume_offset: 0,
        guard_length: 0,
        guard_hash: 0,
        matched_lines: Vec::new(),
        tail_line: None,
        oversized_skipped: 0,
    };

    let Ok(mut file) = File::open(path) else {
        return empty_fail();
    };
    let compressed = path
        .to_str()
        .is_some_and(|s| s.ends_with(".jsonl.zst"));

    let mut resumed = false;
    let mut start: u64 = 0;
    if !compressed
        && resume_offset_in > 0
        && guard_matches(&mut file, resume_offset_in, guard_length_in, guard_hash_in)
    {
        start = resume_offset_in;
        resumed = true;
    }

    if file.seek(SeekFrom::Start(start)).is_err() {
        return empty_fail();
    }

    let finders: Vec<memmem::Finder<'_>> = markers
        .iter()
        .map(|m| memmem::Finder::new(m.as_bytes()))
        .collect();
    let max_bytes = max_line_bytes.unwrap_or(8 * 1024 * 1024);

    let mut matched_lines = Vec::new();
    let mut pending = Vec::new();
    let mut pending_oversized = false;
    let mut oversized_skipped: usize = 0;
    let mut scan_offset: u64 = start;
    let mut resume_offset: u64 = start;

    let mut process_chunk = |chunk: &[u8]| {
        let mut cursor = 0usize;
        while cursor < chunk.len() {
            match memchr(b'\n', &chunk[cursor..]) {
                None => {
                    let rest = &chunk[cursor..];
                    if !pending_oversized {
                        if pending.len() + rest.len() <= max_bytes {
                            pending.extend_from_slice(rest);
                        } else {
                            pending.clear();
                            pending_oversized = true;
                        }
                    }
                    break;
                }
                Some(rel_nl) => {
                    let line_slice = &chunk[cursor..cursor + rel_nl];
                    if pending.is_empty() && !pending_oversized {
                        if line_slice.len() > max_bytes {
                            oversized_skipped += 1;
                        } else if line_matches_any(line_slice, &finders) {
                            matched_lines.push(
                                String::from_utf8_lossy(trim_cr(line_slice)).into_owned(),
                            );
                        }
                    } else if pending_oversized {
                        oversized_skipped += 1;
                        pending_oversized = false;
                        pending.clear();
                    } else {
                        if pending.len() + line_slice.len() > max_bytes {
                            oversized_skipped += 1;
                        } else {
                            pending.extend_from_slice(line_slice);
                            if line_matches_any(&pending, &finders) {
                                matched_lines.push(
                                    String::from_utf8_lossy(trim_cr(&pending)).into_owned(),
                                );
                            }
                        }
                        pending.clear();
                    }
                    cursor += rel_nl + 1;
                    resume_offset = scan_offset + cursor as u64;
                }
            }
        }
        scan_offset += chunk.len() as u64;
    };

    let mut buf = vec![0u8; READ_CHUNK_BYTES];
    if compressed {
        let Ok(mut decoder) = StreamingDecoder::new(&mut file) else {
            return empty_fail();
        };
        loop {
            match decoder.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => process_chunk(&buf[..n]),
                Err(_) => return empty_fail(),
            }
        }
    } else {
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => process_chunk(&buf[..n]),
                Err(_) => return empty_fail(),
            }
        }
    }

    let tail_line = if !pending_oversized && !pending.is_empty() && line_matches_any(&pending, &finders) {
        Some(String::from_utf8_lossy(trim_cr(&pending)).into_owned())
    } else {
        if pending_oversized {
            oversized_skipped += 1;
        }
        None
    };

    let (final_resume_offset, guard_length, guard_hash) = if compressed {
        (0, 0, 0)
    } else {
        let gl = (resume_offset as usize).min(GUARD_LENGTH);
        let mut gh = 0u32;
        if gl > 0 && file.seek(SeekFrom::Start(resume_offset - gl as u64)).is_ok() {
            let mut gbuf = vec![0u8; gl];
            if file.read_exact(&mut gbuf).is_ok() {
                gh = fnv1a(&gbuf);
            }
        }
        (resume_offset, gl, gh)
    };

    FilterLinesResponse {
        ok: true,
        resumed,
        resume_offset: final_resume_offset,
        guard_length,
        guard_hash,
        matched_lines,
        tail_line,
        oversized_skipped,
    }
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
            Request::List {
                root,
                since_ms,
                file_name,
            } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_list(Path::new(&root), since_ms, file_name.as_deref()),
            }),
            Request::FilterLines {
                path,
                markers,
                resume_offset,
                guard_length,
                guard_hash,
                max_line_bytes,
            } => serde_json::to_string(&ServeResponse {
                id: &envelope.id,
                result: run_filter_lines(
                    Path::new(&path),
                    &markers,
                    resume_offset,
                    guard_length,
                    guard_hash,
                    max_line_bytes,
                ),
            }),
        };
        if let Ok(json) = response
            && (writer.write_all(json.as_bytes()).is_err()
                || writer.write_all(b"\n").is_err()
                || writer.flush().is_err())
        {
            break;
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

    let output = match request {
        Request::List {
            root,
            since_ms,
            file_name,
        } => serde_json::to_string(&run_list(Path::new(&root), since_ms, file_name.as_deref())),
        Request::FilterLines {
            path,
            markers,
            resume_offset,
            guard_length,
            guard_hash,
            max_line_bytes,
        } => serde_json::to_string(&run_filter_lines(
            Path::new(&path),
            &markers,
            resume_offset,
            guard_length,
            guard_hash,
            max_line_bytes,
        )),
    };

    match output {
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
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("j3-usage-scanner-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fnv1a_matches_js_implementation() {
        assert_eq!(fnv1a(b""), 0x811c_9dc5);
        assert_eq!(fnv1a(b"hello"), 0x4f9f_2cab);
        assert_eq!(fnv1a(b"{\"usage\":123}\n"), 0xb64a_0872);
    }

    #[test]
    fn lists_transcript_files_recursively_and_filters_by_name() {
        let dir = make_temp_dir("list");
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.join("a.jsonl"), "{}\n").unwrap();
        fs::write(nested.join("b.jsonl.zst"), b"stub").unwrap();
        fs::write(nested.join("ignore.txt"), "x").unwrap();

        let result = run_list(&dir, 0.0, None);
        assert_eq!(result.failed_paths, 0);
        assert_eq!(result.walked.len(), 2);
        assert_eq!(result.files.len(), 2);

        let named = run_list(&dir, 0.0, Some("ignore.txt"));
        assert_eq!(named.files.len(), 1);
        assert!(named.files[0].path.ends_with("ignore.txt"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_marker_lines_and_resumes_safely_with_guard_hash() {
        let dir = make_temp_dir("filter");
        let file_path = dir.join("session.jsonl");
        {
            let mut f = File::create(&file_path).unwrap();
            writeln!(f, "{{\"type\":\"noise\"}}").unwrap();
            writeln!(f, "{{\"type\":\"usage\",\"tokens\":10}}").unwrap();
            write!(f, "{{\"type\":\"usage\",\"tokens\":20}}").unwrap();
        }

        let markers = vec!["\"usage\"".to_string()];
        let first = run_filter_lines(&file_path, &markers, 0, 0, 0, None);
        assert!(first.ok);
        assert!(!first.resumed);
        assert_eq!(first.matched_lines, vec!["{\"type\":\"usage\",\"tokens\":10}"]);
        assert_eq!(
            first.tail_line.as_deref(),
            Some("{\"type\":\"usage\",\"tokens\":20}")
        );

        // Append newline and another usage line, then resume from previous offset.
        {
            let mut f = fs::OpenOptions::new().append(true).open(&file_path).unwrap();
            writeln!(f).unwrap();
            writeln!(f, "{{\"type\":\"usage\",\"tokens\":30}}").unwrap();
        }

        let second = run_filter_lines(
            &file_path,
            &markers,
            first.resume_offset,
            first.guard_length,
            first.guard_hash,
            None,
        );
        assert!(second.ok);
        assert!(second.resumed);
        assert_eq!(
            second.matched_lines,
            vec![
                "{\"type\":\"usage\",\"tokens\":20}",
                "{\"type\":\"usage\",\"tokens\":30}"
            ]
        );
        assert_eq!(second.tail_line, None);

        // Overwrite file prefix so guard hash mismatches and forces full rescan.
        fs::write(&file_path, "{\"type\":\"usage\",\"tokens\":99}\n").unwrap();
        let rewritten = run_filter_lines(
            &file_path,
            &markers,
            second.resume_offset,
            second.guard_length,
            second.guard_hash,
            None,
        );
        assert!(rewritten.ok);
        assert!(!rewritten.resumed);
        assert_eq!(
            rewritten.matched_lines,
            vec!["{\"type\":\"usage\",\"tokens\":99}"]
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
