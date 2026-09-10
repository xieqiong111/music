use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader},
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub struct Backend {
    child: Child,
    pub origin: String,
}

impl Backend {
    pub fn start(resources: &Path, data: &Path) -> io::Result<Self> {
        fs::create_dir_all(data)?;
        let log = OpenOptions::new().create(true).append(true).open(data.join("backend.log"))?;
        let child = Command::new(resources.join("node.exe"))
            .arg(resources.join("desktop-server.mjs"))
            .arg(data)
            .current_dir(resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()?;
        let mut backend = Self { child, origin: String::new() };
        let stdout = backend.child.stdout.take().expect("piped stdout");
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(origin) = line.strip_prefix("PLAYLIST_EXPORTER_READY=") {
                    let _ = send.send(origin.to_owned());
                }
                // Keep draining the pipe after readiness so request logs cannot
                // block Node or trigger EPIPE when the reader disappears.
            }
        });
        let origin = receive.recv_timeout(Duration::from_secs(30)).map_err(|error| {
            io::Error::new(io::ErrorKind::TimedOut, format!("Backend did not start ({error}); see {}", data.join("backend.log").display()))
        })?;
        let port = origin.strip_prefix("http://127.0.0.1:")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| *value > 0);
        if port.is_none() || backend.child.try_wait()?.is_some() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid backend readiness response"));
        }
        backend.origin = origin;
        Ok(backend)
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        // EOF asks the wrapper to close HTTP connections and jobs gracefully.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) { return; }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
