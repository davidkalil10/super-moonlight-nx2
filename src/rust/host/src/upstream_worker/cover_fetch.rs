use std::{
    ffi::{CStr, CString, c_void},
    io::Read,
    os::unix::ffi::OsStrExt,
    path::Path,
};

use super::{WorkerError, WorkerResult, native};
use moonlight_nx2_host::cover::{self, CHUNK_BYTES, MAX_COVER_BYTES};

const WRITEDATA: libc::c_int = 10_001;
const URL: libc::c_int = 10_002;
const WRITEFUNCTION: libc::c_int = 20_011;
const CERT: libc::c_int = 10_025;
const KEY: libc::c_int = 10_087;
const FAIL_ON_ERROR: libc::c_int = 45;
const VERIFY_PEER: libc::c_int = 64;
const VERIFY_HOST: libc::c_int = 81;
const TIMEOUT_MS: libc::c_int = 155;
const CONNECT_TIMEOUT_MS: libc::c_int = 156;

unsafe extern "C" {
    fn curl_easy_init() -> *mut c_void;
    fn curl_easy_setopt(handle: *mut c_void, option: libc::c_int, ...) -> libc::c_int;
    fn curl_easy_perform(handle: *mut c_void) -> libc::c_int;
    fn curl_easy_cleanup(handle: *mut c_void);
    fn SHA256(data: *const u8, len: usize, digest: *mut u8) -> *mut u8;
}

struct Curl(*mut c_void);
impl Drop for Curl {
    fn drop(&mut self) {
        unsafe { curl_easy_cleanup(self.0) }
    }
}

#[derive(Default)]
struct Download {
    bytes: Vec<u8>,
    exceeded: bool,
}

unsafe extern "C" fn receive(
    data: *mut c_void,
    size: usize,
    count: usize,
    context: *mut c_void,
) -> usize {
    let Some(length) = size.checked_mul(count) else {
        return 0;
    };
    if length == 0 || data.is_null() || context.is_null() {
        return 0;
    }
    let download = unsafe { &mut *context.cast::<Download>() };
    if length > MAX_COVER_BYTES.saturating_sub(download.bytes.len()) {
        download.exceeded = true;
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length) };
    download.bytes.extend_from_slice(bytes);
    length
}

pub(super) fn fetch(
    server: &native::SERVER_DATA,
    host: &CStr,
    key_path: &Path,
    app: u32,
) -> WorkerResult {
    if !server.paired || app == 0 {
        return Err(WorkerError::Failed);
    }
    let host = host.to_str().map_err(|_| ())?;
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
    {
        return Err(WorkerError::Failed);
    }
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let mut client_id = String::new();
    std::fs::File::open(key_path.join("uniqueid.dat"))
        .map_err(|_| ())?
        .take(64)
        .read_to_string(&mut client_id)
        .map_err(|_| ())?;
    if client_id.is_empty() || !client_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(WorkerError::Failed);
    }
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .map_err(|_| ())?
        .read_exact(&mut random)
        .map_err(|_| ())?;
    random[6] = (random[6] & 0x0f) | 0x40;
    random[8] = (random[8] & 0x3f) | 0x80;
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        random[0],
        random[1],
        random[2],
        random[3],
        random[4],
        random[5],
        random[6],
        random[7],
        random[8],
        random[9],
        random[10],
        random[11],
        random[12],
        random[13],
        random[14],
        random[15]
    );
    let url = CString::new(format!("https://{host}:{}/appasset?uniqueid={client_id}&uuid={uuid}&appid={app}&AssetType=2&AssetIdx=0", server.httpsPort)).map_err(|_| ())?;
    let cert = CString::new(key_path.join("client.pem").as_os_str().as_bytes()).map_err(|_| ())?;
    let key = CString::new(key_path.join("key.pem").as_os_str().as_bytes()).map_err(|_| ())?;
    let handle = Curl(unsafe { curl_easy_init() });
    if handle.0.is_null() {
        return Err(WorkerError::Failed);
    }
    let mut download = Download::default();
    unsafe {
        // Sunshine answers one HTTPS client at a time, so the session connection goes first.
        native::http_cleanup();
        let settings = [
            curl_easy_setopt(handle.0, URL, url.as_ptr()),
            curl_easy_setopt(handle.0, CERT, cert.as_ptr()),
            curl_easy_setopt(handle.0, KEY, key.as_ptr()),
            curl_easy_setopt(
                handle.0,
                WRITEDATA,
                (&mut download as *mut Download).cast::<c_void>(),
            ),
            curl_easy_setopt(
                handle.0,
                WRITEFUNCTION,
                receive as unsafe extern "C" fn(*mut c_void, usize, usize, *mut c_void) -> usize,
            ),
            curl_easy_setopt(handle.0, FAIL_ON_ERROR, 1 as libc::c_long),
            curl_easy_setopt(handle.0, VERIFY_PEER, 0 as libc::c_long),
            curl_easy_setopt(handle.0, VERIFY_HOST, 0 as libc::c_long),
            curl_easy_setopt(handle.0, TIMEOUT_MS, 15_000 as libc::c_long),
            curl_easy_setopt(handle.0, CONNECT_TIMEOUT_MS, 5_000 as libc::c_long),
        ];
        if settings.iter().any(|status| *status != 0) {
            return Err(WorkerError::Failed);
        }
        let status = curl_easy_perform(handle.0);
        if download.exceeded {
            eprintln!("moonlight-worker cover app={app} over {MAX_COVER_BYTES} bytes");
            return Err(WorkerError::TooLarge);
        }
        if status != 0 {
            eprintln!("moonlight-worker cover app={app} curl={status}");
            return Err(WorkerError::Failed);
        }
    }
    cover::validate_png(&download.bytes).map_err(|error| {
        eprintln!(
            "moonlight-worker cover app={app} rejected bytes={}",
            download.bytes.len()
        );
        match error {
            cover::Error::TooLarge => WorkerError::TooLarge,
            _ => WorkerError::Failed,
        }
    })?;
    let mut digest = [0u8; 32];
    if unsafe {
        SHA256(
            download.bytes.as_ptr(),
            download.bytes.len(),
            digest.as_mut_ptr(),
        )
    }
    .is_null()
    {
        return Err(WorkerError::Failed);
    }
    for (index, chunk) in download.bytes.chunks(CHUNK_BYTES).enumerate() {
        super::output(
            &serde_json::json!({"event":"cover_chunk","total":download.bytes.len(),"offset":index * CHUNK_BYTES,"data":cover::encode_base64(chunk)}),
        )?;
    }
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    super::output(&serde_json::json!({"event":"cover_done","sha256":hash}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    #[test]
    fn receive_enforces_download_cap() {
        let mut download = Download::default();
        let mut block = vec![7u8; MAX_COVER_BYTES];
        let context = (&mut download as *mut Download).cast();
        assert_eq!(
            unsafe { receive(block.as_mut_ptr().cast(), 1, block.len(), context) },
            block.len()
        );
        assert_eq!(download.bytes.len(), MAX_COVER_BYTES);
        assert_eq!(
            unsafe { receive(block.as_mut_ptr().cast(), 1, 1, context) },
            0
        );
        assert!(download.exceeded);
        assert_eq!(download.bytes.len(), MAX_COVER_BYTES);
    }

    #[test]
    fn fetches_cover_after_the_session_request() {
        let dir =
            std::env::temp_dir().join(format!("moonlight-cover-https-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let cert = dir.join("client.pem");
        let key = dir.join("key.pem");
        assert!(
            Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=localhost",
                    "-days",
                    "1",
                    "-keyout"
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(dir.join("uniqueid.dat"), b"0123456789abcdef").unwrap();
        let script = r#"
import http.server, pathlib, ssl, sys
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def do_GET(self):
  if self.path.startswith('/serverinfo'):
   body=b'<root/>'
  else:
   assert self.path.startswith('/appasset?') and 'appid=7' in self.path
   body=bytearray(70000)
   body[:16]=b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
   body[16:20]=(600).to_bytes(4,'big')
   body[20:24]=(800).to_bytes(4,'big')
   self.server.served=True
  self.send_response(200); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
 def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
server.served=False
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[1],sys.argv[2])
server.socket=ctx.wrap_socket(server.socket,server_side=True)
pathlib.Path(sys.argv[3]).write_text(str(server.server_port))
while not server.served: server.handle_request()
"#;
        let mut server = Server(
            Command::new("python3")
                .args(["-c", script])
                .arg(&cert)
                .arg(&key)
                .arg(dir.join("port"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !dir.join("port").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let port = std::fs::read_to_string(dir.join("port"))
            .unwrap()
            .parse()
            .unwrap();
        let mut data: native::SERVER_DATA = unsafe { std::mem::zeroed() };
        data.paired = true;
        data.httpsPort = port;
        let keys = CString::new(dir.as_os_str().as_bytes()).unwrap();
        let info = CString::new(format!("https://127.0.0.1:{port}/serverinfo")).unwrap();
        unsafe {
            assert_eq!(native::http_init(keys.as_ptr(), 0), 0);
            let reply = native::http_create_data();
            assert_eq!(native::http_request(info.as_ptr().cast_mut(), reply), 0);
            native::http_free_data(reply);
        }
        assert!(fetch(&data, c"127.0.0.1", &dir, 7).is_ok());
        assert!(server.0.wait().unwrap().success());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
