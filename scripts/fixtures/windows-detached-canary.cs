// Disposable acceptance fixture. Preserve the caller's token and Job membership,
// while excluding the SDK's inheritable capture pipes from the background child.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CrownForgeDetachedCanary
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, BufferWidth, BufferHeight, Fill;
        public uint Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint sharing,
        ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Start(string executable, string arguments, string directory)
    {
        var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
        IntPtr nul = CreateFileW("NUL", 0xC0000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (nul == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false;
        try
        {
            IntPtr size = IntPtr.Zero;
            if (InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size) || Marshal.GetLastWin32Error() != 122)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(handles, nul);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: the NUL handle is the entire list.
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var startup = new StartupInfoEx {
                Startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x100,
                    Input = nul, Output = nul, Error = nul }, Attributes = attributes
            };
            ProcessInfo process;
            // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW. No BREAKAWAY flag.
            if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + arguments),
                IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, directory, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return checked((int)process.ProcessId); }
            finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            CloseHandle(nul);
        }
    }
}
