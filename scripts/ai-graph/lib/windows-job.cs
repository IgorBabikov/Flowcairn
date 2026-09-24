using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

// Lifecycle containment only. No filesystem, network, token or client permission policy.
internal static class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int index);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  // Microsoft CRT argv encoding, including empty arguments and trailing backslashes.
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slash = 0;
    foreach (char c in value) {
      if (c == '\\') { slash++; continue; }
      if (c == '"') { result.Append('\\', slash * 2 + 1); result.Append(c); }
      else { result.Append('\\', slash); result.Append(c); }
      slash = 0;
    }
    result.Append('\\', slash * 2); result.Append('"'); return result.ToString();
  }
  static int Main(string[] args) {
    IntPtr job = IntPtr.Zero; ProcessInfo child = new ProcessInfo(); bool resumed = false;
    try {
      if (args.Length < 2 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1])) throw new Exception();
      string receipt = args[0];
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Exception();
      ExtendedLimit limit = new ExtendedLimit();
      limit.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no BREAKAWAY_OK/SILENT_BREAKAWAY_OK.
      if (!SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Exception();
      Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      foreach (IntPtr handle in new IntPtr[] {startup.Input, startup.Output, startup.Error}) {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !SetHandleInformation(handle, 1, 1)) throw new Exception();
      }
      StringBuilder command = new StringBuilder();
      for (int i = 1; i < args.Length; i++) { if (i > 1) command.Append(' '); command.Append(Quote(args[i])); }
      if (command.Length >= 32767) throw new Exception();
      if (!CreateProcessW(args[1], command, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, null, ref startup, out child)) throw new Exception();
      // A failed assignment never lets project code run.
      if (!AssignProcessToJobObject(job, child.Process)) throw new Exception();
      if (ResumeThread(child.Thread) == 0xffffffff) throw new Exception();
      resumed = true;
      if (WaitForSingleObject(child.Process, 0xffffffff) != 0) throw new Exception();
      uint exit;
      if (!GetExitCodeProcess(child.Process, out exit)) throw new Exception();
      if (!TerminateJobObject(job, 125)) throw new Exception();
      bool empty = false;
      for (int attempt = 0; attempt < 1000; attempt++) {
        Accounting account;
        if (!QueryInformationJobObject(job, 1, out account, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception();
        if (account.Active == 0) { empty = true; break; }
        Thread.Sleep(10);
      }
      if (!empty) throw new Exception();
      using (FileStream output = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        byte[] bytes = Encoding.UTF8.GetBytes("{\"version\":1,\"reaped\":true,\"exitCode\":" + exit.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}\n");
        output.Write(bytes, 0, bytes.Length); output.Flush(true);
      }
      return unchecked((int)exit);
    } catch {
      Console.Error.WriteLine("WINDOWS_JOB_FAILED"); return 125;
    } finally {
      if (!resumed && child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 125); WaitForSingleObject(child.Process, 10000); }
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
