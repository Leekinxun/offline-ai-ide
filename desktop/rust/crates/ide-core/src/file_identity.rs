use crate::{CoreError, Result};
use std::{fs, path::Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume: u64,
    pub index: u64,
}

pub fn directory_identity(path: &Path) -> Result<FileIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Workspace identity is not a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(FileIdentity {
            volume: metadata.dev(),
            index: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::{
            ffi::c_void,
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };
        #[repr(C)]
        struct Information {
            attributes: u32,
            created: [u32; 2],
            accessed: [u32; 2],
            modified: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(handle: *mut c_void, info: *mut Information) -> i32;
        }
        let directory = fs::OpenOptions::new()
            .read(true)
            .share_mode(7)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)?;
        let mut info = std::mem::MaybeUninit::<Information>::uninit();
        // SAFETY: the owned directory handle remains open and the output buffer has the documented layout.
        if unsafe { GetFileInformationByHandle(directory.as_raw_handle(), info.as_mut_ptr()) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: a successful call initialized every field in Information.
        let info = unsafe { info.assume_init() };
        if info.attributes & 0x400 != 0 {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Workspace root is a reparse point",
            ));
        }
        Ok(FileIdentity {
            volume: info.volume as u64,
            index: ((info.index_high as u64) << 32) | info.index_low as u64,
        })
    }
}
