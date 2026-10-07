// Real VRAM per process and per card. nvidia-smi gives each card's total use, but on Windows (WDDM) it can't say which
// process holds it ("Not available in WDDM driver model"). Windows' own GPU counters can (Task Manager uses them):
// "\GPU Process Memory(pid_<pid>_luid_<adapter>_phys_0)\Dedicated Usage". DXGI says which adapter LUID is which card
// (its name and memory size), and nvidia-smi's names and sizes match those to nvidia-smi's card numbers.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
pub struct ProcVram {
    pub gpu: u32,     // nvidia-smi's card index
    pub pid: u32,
    pub path: String, // the program's full path ("" when Windows won't say)
    pub name: String, // its file name ("dwm.exe"), known even for protected processes
    pub parent: u32,  // its parent's pid (llama.cpp's router starts one process per model)
    pub parent_path: String, // a venv's python.exe starts the real interpreter as its child: the venv is in this path
    pub mib: f64,
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct Luid {
        pub low: u32,
        pub high: i32,
    }
    #[repr(C)]
    pub struct AdapterDesc1 {
        pub description: [u16; 128],
        pub vendor_id: u32,
        pub device_id: u32,
        pub sub_sys_id: u32,
        pub revision: u32,
        pub dedicated_video_memory: usize,
        pub dedicated_system_memory: usize,
        pub shared_system_memory: usize,
        pub luid: Luid,
        pub flags: u32,
    }
    #[repr(C)]
    pub struct Guid(pub u32, pub u16, pub u16, pub [u8; 8]);
    // IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}
    pub const IID_IDXGIFACTORY1: Guid = Guid(0x770aae78, 0xf26f, 0x4dba, [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);

    #[link(name = "dxgi")]
    extern "system" {
        pub fn CreateDXGIFactory1(riid: *const Guid, factory: *mut *mut c_void) -> i32;
    }

    #[repr(C)]
    pub struct CounterItem {
        pub name: *const u16,
        pub status: u32,
        pub _pad: u32,
        pub value: i64, // PDH_FMT_LARGE
    }
    #[link(name = "pdh")]
    extern "system" {
        pub fn PdhOpenQueryW(source: *const u16, user: usize, query: *mut isize) -> u32;
        pub fn PdhAddEnglishCounterW(query: isize, path: *const u16, user: usize, counter: *mut isize) -> u32;
        pub fn PdhCollectQueryData(query: isize) -> u32;
        pub fn PdhGetFormattedCounterArrayW(counter: isize, format: u32, size: *mut u32, count: *mut u32, items: *mut CounterItem) -> u32;
        pub fn PdhCloseQuery(query: isize) -> u32;
    }
    #[repr(C)]
    pub struct ProcessEntry32W {
        pub size: u32,
        pub usage: u32,
        pub pid: u32,
        pub heap: usize,
        pub module: u32,
        pub threads: u32,
        pub parent: u32,
        pub pri: i32,
        pub flags: u32,
        pub exe: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        pub fn Process32FirstW(snap: isize, entry: *mut ProcessEntry32W) -> i32;
        pub fn Process32NextW(snap: isize, entry: *mut ProcessEntry32W) -> i32;
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        pub fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        pub fn CloseHandle(h: isize) -> i32;
    }

    /// Calls a COM method by its vtable slot.
    pub unsafe fn vcall<F: Copy>(obj: *mut c_void, slot: usize) -> F {
        let vtbl = *(obj as *const *const usize);
        std::mem::transmute_copy(&*vtbl.add(slot))
    }
}

/// Every DXGI adapter: (LUID as "0x0000xxxx_0x0000yyyy" the way the counters spell it, its name, dedicated MiB).
#[cfg(windows)]
fn adapters() -> Vec<(String, String, f64)> {
    use std::ffi::c_void;
    use win::*;
    let mut out = Vec::new();
    unsafe {
        let mut f: *mut c_void = std::ptr::null_mut();
        if CreateDXGIFactory1(&IID_IDXGIFACTORY1, &mut f) < 0 || f.is_null() {
            return out;
        }
        // IDXGIFactory1::EnumAdapters1 is vtable slot 12; IDXGIAdapter1::GetDesc1 slot 10; Release slot 2.
        let enum_adapters1: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32 = vcall(f, 12);
        let release_f: unsafe extern "system" fn(*mut c_void) -> u32 = vcall(f, 2);
        for i in 0..16 {
            let mut a: *mut c_void = std::ptr::null_mut();
            if enum_adapters1(f, i, &mut a) < 0 || a.is_null() {
                break;
            }
            let get_desc1: unsafe extern "system" fn(*mut c_void, *mut AdapterDesc1) -> i32 = vcall(a, 10);
            let release_a: unsafe extern "system" fn(*mut c_void) -> u32 = vcall(a, 2);
            let mut d: AdapterDesc1 = std::mem::zeroed();
            if get_desc1(a, &mut d) >= 0 {
                let n = d.description.iter().position(|&c| c == 0).unwrap_or(128);
                let name = String::from_utf16_lossy(&d.description[..n]);
                let luid = format!("0x{:08x}_0x{:08x}", d.luid.high as u32, d.luid.low);
                out.push((luid, name, d.dedicated_video_memory as f64 / 1048576.0));
            }
            release_a(a);
        }
        release_f(f);
    }
    out
}

/// Dedicated VRAM per (pid, adapter LUID) from Windows' GPU counters, in MiB.
#[cfg(windows)]
fn counters() -> Vec<(u32, String, f64)> {
    use win::*;
    let mut out = Vec::new();
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    unsafe {
        let mut q: isize = 0;
        if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != 0 {
            return out;
        }
        let mut c: isize = 0;
        let path = wide("\\GPU Process Memory(*)\\Dedicated Usage");
        if PdhAddEnglishCounterW(q, path.as_ptr(), 0, &mut c) == 0 && PdhCollectQueryData(q) == 0 {
            let (mut size, mut count) = (0u32, 0u32);
            const PDH_FMT_LARGE: u32 = 0x400;
            PdhGetFormattedCounterArrayW(c, PDH_FMT_LARGE, &mut size, &mut count, std::ptr::null_mut());
            if size > 0 {
                let mut buf = vec![0u8; size as usize];
                let items = buf.as_mut_ptr() as *mut CounterItem;
                if PdhGetFormattedCounterArrayW(c, PDH_FMT_LARGE, &mut size, &mut count, items) == 0 {
                    for i in 0..count as usize {
                        let it = &*items.add(i);
                        // PDH_CSTATUS_VALID_DATA (0) or PDH_CSTATUS_NEW_DATA (1).
                        if it.status > 1 || it.value <= 0 || it.name.is_null() {
                            continue;
                        }
                        let mut n = 0;
                        while *it.name.add(n) != 0 {
                            n += 1;
                        }
                        let inst = String::from_utf16_lossy(std::slice::from_raw_parts(it.name, n));
                        // pid_1234_luid_0x00000000_0x00012ddb_phys_0
                        let mut parts = inst.split('_');
                        if parts.next() != Some("pid") {
                            continue;
                        }
                        let Some(pid) = parts.next().and_then(|p| p.parse::<u32>().ok()) else { continue };
                        if parts.next() != Some("luid") {
                            continue;
                        }
                        let luid = format!("{}_{}", parts.next().unwrap_or(""), parts.next().unwrap_or("")).to_ascii_lowercase(); // the API spells hex in capitals
                        out.push((pid, luid, it.value as f64 / 1048576.0));
                    }
                }
            }
        }
        PdhCloseQuery(q);
    }
    out
}

#[cfg(windows)]
fn process_path(pid: u32) -> String {
    use win::*;
    unsafe {
        let h = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if h == 0 {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..len as usize])
        }
    }
}

/// Every process's file name and parent, from a Toolhelp snapshot (works for protected processes too).
#[cfg(windows)]
fn snapshot() -> HashMap<u32, (String, u32)> {
    use win::*;
    let mut out = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if snap == -1 || snap == 0 {
            return out;
        }
        let mut e: ProcessEntry32W = std::mem::zeroed();
        e.size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let n = e.exe.iter().position(|&c| c == 0).unwrap_or(260);
            out.insert(e.pid, (String::from_utf16_lossy(&e.exe[..n]), e.parent));
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}
/// Matches DXGI adapters to nvidia-smi's cards: by name ("NVIDIA GeForce RTX 3060" contains "RTX 3060"), and for two
/// cards of the same model by the closer memory size, then in order.
pub(crate) fn luid_to_gpu(adapters: &[(String, String, f64)], gpus: &[(u32, String, f64)]) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    let mut taken = Vec::new();
    for (luid, name, mib) in adapters {
        let n = name.to_lowercase();
        let best = gpus
            .iter()
            .filter(|(i, gname, _)| !taken.contains(i) && (n.contains(&gname.to_lowercase()) || gname.to_lowercase().contains(&n)))
            .min_by(|a, b| (a.2 - mib).abs().total_cmp(&(b.2 - mib).abs()));
        if let Some((i, _, _)) = best {
            taken.push(*i);
            map.insert(luid.clone(), *i);
        }
    }
    map
}

/// Each process's dedicated VRAM on each NVIDIA card (nvidia-smi's numbering), largest first. `gpus` is nvidia-smi's
/// (index, name, MiB total) for every card.
#[cfg(windows)]
pub fn per_process(gpus: &[(u32, String, f64)]) -> Vec<ProcVram> {
    let map = luid_to_gpu(&adapters(), gpus);
    let mut out: Vec<ProcVram> = counters()
        .into_iter()
        .filter(|(_, _, mib)| *mib >= 1.0)
        .filter_map(|(pid, luid, mib)| map.get(&luid).map(|&gpu| ProcVram { gpu, pid, path: String::new(), name: String::new(), parent: 0, parent_path: String::new(), mib }))
        .collect();
    let mut paths: HashMap<u32, String> = HashMap::new();
    let procs = snapshot();
    for p in out.iter_mut() {
        p.path = paths.entry(p.pid).or_insert_with(|| process_path(p.pid)).clone();
        if let Some((name, parent)) = procs.get(&p.pid) {
            p.name = name.clone();
            p.parent = *parent;
        }
        if p.parent != 0 {
            p.parent_path = paths.entry(p.parent).or_insert_with(|| process_path(p.parent)).clone();
        }
    }
    out.sort_by(|a, b| b.mib.total_cmp(&a.mib));
    out
}

#[cfg(not(windows))]
pub fn per_process(_gpus: &[(u32, String, f64)]) -> Vec<ProcVram> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_match_cards_by_name_then_size() {
        let adapters = vec![
            ("0x0_0x12ddb".to_string(), "NVIDIA GeForce RTX 3060".to_string(), 12100.0),
            ("0x0_0x11ddb".to_string(), "NVIDIA GeForce RTX 2060".to_string(), 6000.0),
            ("0x0_0x1407d".to_string(), "Microsoft Basic Render Driver".to_string(), 0.0),
        ];
        let gpus = vec![(0, "RTX 2060".to_string(), 6144.0), (1, "RTX 3060".to_string(), 12288.0)];
        let m = luid_to_gpu(&adapters, &gpus);
        assert_eq!(m.get("0x0_0x12ddb"), Some(&1));
        assert_eq!(m.get("0x0_0x11ddb"), Some(&0));
        assert_eq!(m.get("0x0_0x1407d"), None);
        // Two of the same card: the closer size wins, each card used once.
        let twins = vec![("a".to_string(), "NVIDIA GeForce RTX 3060".to_string(), 12100.0), ("b".to_string(), "NVIDIA GeForce RTX 3060".to_string(), 8000.0)];
        let g2 = vec![(0, "RTX 3060".to_string(), 8192.0), (1, "RTX 3060".to_string(), 12288.0)];
        let m2 = luid_to_gpu(&twins, &g2);
        assert_eq!((m2.get("a"), m2.get("b")), (Some(&1), Some(&0)));
    }

    #[test]
    fn struct_layouts() {
        #[cfg(windows)]
        {
            assert_eq!(std::mem::size_of::<win::AdapterDesc1>(), 312);
            assert_eq!(std::mem::size_of::<win::CounterItem>(), 24);
        }
    }

    #[test]
    #[ignore] // reads this PC's cards: cargo test --lib vram::tests::live -- --ignored --nocapture
    fn live() {
        let cards = vec![(0, "NVIDIA GeForce RTX 2060".to_string(), 6144.0), (1, "NVIDIA GeForce RTX 3060".to_string(), 12288.0)];
        #[cfg(windows)]
        println!("adapters: {:?}", adapters());
        for p in per_process(&cards) {
            println!("gpu {} pid {} {} {:.0} MiB {} | parent {}", p.gpu, p.pid, p.name, p.mib, p.path, p.parent_path);
        }
    }
}