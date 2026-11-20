//! Les processus lancés par Nel Code (commandes de l'agent, serveurs MCP stdio, claude) : sans fenêtre, et dans un
//! groupe qu'on arrête d'un coup avec tous les enfants.
//! - Windows : un Job Object. Le processus est créé suspendu et mis dans le job avant de démarrer (aucun enfant ne
//!   peut lui échapper) ; fermer le job (drop, ou fin de Nel Code) tue ce qui reste.
//! - Linux, macOS : un groupe de processus (setpgid à la création) ; `kill` et le drop envoient SIGKILL au groupe.
//!   Sous Linux, le processus reçoit aussi SIGKILL si Nel Code s'arrête (PR_SET_PDEATHSIG). Un enfant qui quitte le
//!   groupe (setsid) n'est plus suivi.

use std::process::{Child, Command};

/// Pas de fenêtre de console pour le processus (Windows ; rien ailleurs).
pub fn hide_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    cmd
}

/// Le groupe d'un processus lancé par `spawn` : le tuer tue le processus et tous ses enfants ; le lâcher (drop) aussi.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(windows)]
    pid: u32,
    #[cfg(unix)]
    pgid: libc::pid_t,
}

// SAFETY : un HANDLE de job s'utilise depuis n'importe quel thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

/// Lance `cmd` sans fenêtre, dans un nouveau groupe.
pub fn spawn(cmd: &mut Command) -> std::io::Result<(Child, Job)> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::JobObjects::*;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        let handle = unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err(std::io::Error::other(format!("Job Object : {}", std::io::Error::last_os_error())));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
            h
        };
        let mut job = Job { handle, pid: 0 };
        let child = cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED).spawn()?;
        unsafe { AssignProcessToJobObject(job.handle, child.as_raw_handle() as _) };
        resume(child.id());
        job.pid = child.id();
        Ok((child, job))
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        let pgid = child.id() as libc::pid_t;
        Ok((child, Job { pgid }))
    }
}

impl Job {
    /// Tue le processus et tous ses enfants.
    pub fn kill(&self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
    }

    /// Demande un arrêt propre, comme Ctrl+C dans un terminal : sous Windows, Ctrl+C sur la console du processus
    /// (envoyé par un Nel Code à part, voir `ctrl_c_helper`) ; ailleurs, SIGINT au groupe. Rend false s'il n'est pas
    /// parti.
    pub fn interrupt(&self) -> bool {
        #[cfg(windows)]
        {
            let Ok(exe) = std::env::current_exe() else { return false };
            let mut cmd = Command::new(exe);
            hide_window(&mut cmd);
            cmd.args([CTRL_C_ARG, &self.pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGINT) == 0
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        // Ce qui reste du groupe (un enfant détaché) est tué, comme à la fermeture d'un Job Object.
        #[cfg(unix)]
        self.kill();
    }
}

/// Reprend un processus créé suspendu (CREATE_SUSPENDED) : tous ses threads.
#[cfg(windows)]
fn resume(pid: u32) {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap.is_null() || snap == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return;
        }
        let mut t: THREADENTRY32 = std::mem::zeroed();
        t.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut ok = Thread32First(snap, &mut t);
        while ok != 0 {
            if t.th32OwnerProcessID == pid {
                let th = OpenThread(THREAD_SUSPEND_RESUME, 0, t.th32ThreadID);
                if !th.is_null() {
                    ResumeThread(th);
                    windows_sys::Win32::Foundation::CloseHandle(th);
                }
            }
            ok = Thread32Next(snap, &mut t);
        }
        windows_sys::Win32::Foundation::CloseHandle(snap);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Windows : Ctrl+C

/// L'argument caché qui fait de Nel Code l'envoyeur d'un Ctrl+C (voir `ctrl_c_helper`).
#[cfg(windows)]
pub const CTRL_C_ARG: &str = "--nelcode-ctrl-c";

/// Exécuté par un Nel Code lancé avec `--nelcode-ctrl-c <pid>` : s'attache à la console du processus et y envoie
/// Ctrl+C (que Node, comme tout programme console, reçoit comme SIGINT). À part, pour ne jamais toucher à la console
/// du Nel Code principal.
#[cfg(windows)]
pub fn ctrl_c_helper(pid: u32) -> i32 {
    use windows_sys::Win32::System::Console::{AttachConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler};
    unsafe {
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return 2;
        }
        SetConsoleCtrlHandler(None, 1); // ce processus ignore lui-même le Ctrl+C
        let ok = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        std::thread::sleep(std::time::Duration::from_millis(200));
        FreeConsole();
        if ok { 0 } else { 1 }
    }
}

/// Le drapeau « ignorer Ctrl+C » de Windows passe du parent à l'enfant : s'il était levé pour Nel Code (lancé par un
/// programme qui le lève), l'enfant n'entendrait jamais le Ctrl+C de Stop. On le baisse avant de lancer (rien ailleurs).
pub fn allow_ctrl_c() {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Un programme qui en lance un autre et attend : le petit-enfant doit mourir avec le groupe.
    fn parent_and_child() -> Command {
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul & ping -n 30 127.0.0.1 >nul"]);
            c
        }
        #[cfg(unix)]
        {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "sleep 30 & sleep 30; wait"]);
            c
        }
    }

    fn wait_dead(child: &mut Child) -> bool {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if let Ok(Some(_)) = child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn kill_arrete_le_groupe() {
        let (mut child, job) = spawn(parent_and_child().stdin(std::process::Stdio::null())).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        job.kill();
        assert!(wait_dead(&mut child), "le processus est arrêté");
        #[cfg(unix)]
        {
            // Plus personne dans le groupe : kill(-pgid, 0) échoue (ESRCH).
            let end = Instant::now() + Duration::from_secs(5);
            while unsafe { libc::kill(-job.pgid, 0) } == 0 && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert_ne!(unsafe { libc::kill(-job.pgid, 0) }, 0, "les enfants du groupe sont arrêtés");
        }
    }

    #[cfg(unix)]
    #[test]
    fn groupe_a_part_et_sigint() {
        let (mut child, job) = spawn(Command::new("/bin/sh").args(["-c", "trap 'exit 7' INT; sleep 30 & wait"])).unwrap();
        assert_eq!(job.pgid, child.id() as libc::pid_t);
        assert_ne!(unsafe { libc::getpgid(0) }, job.pgid, "Nel Code n'est pas dans le groupe");
        std::thread::sleep(Duration::from_millis(300));
        assert!(job.interrupt());
        let end = Instant::now() + Duration::from_secs(10);
        let code = loop {
            if let Ok(Some(s)) = child.try_wait() {
                break s.code();
            }
            assert!(Instant::now() < end, "SIGINT sans effet");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(code, Some(7), "SIGINT reçu (arrêt propre)");
    }

    #[test]
    fn lacher_le_job_arrete_ce_qui_reste() {
        let (mut child, job) = spawn(parent_and_child().stdin(std::process::Stdio::null())).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        drop(job);
        assert!(wait_dead(&mut child));
    }
}
