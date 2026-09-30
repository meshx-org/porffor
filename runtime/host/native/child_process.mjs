// Native (POSIX libc) host: child processes, as Node's child_process (execSync, execFileSync).
import './c.mjs';

export const execSync = (cmd, options = {}) => {
	const cmdType = Porffor.type(cmd);
	const input = options.input;
	const inputType = Porffor.type(input);
	let status = 0;
	if (input === undefined) {
		Porffor.c`
char *cmd_owned;
char *cmd_ptr = __porffor_node_cstr(MEM, cmd, (i32)cmdType.val, &cmd_owned);
status = system(cmd_ptr);
if (cmd_owned) free(cmd_owned);
`;
	} else {
		Porffor.c`
char *cmd_owned;
char *cmd_ptr = __porffor_node_cstr(MEM, cmd, (i32)cmdType.val, &cmd_owned);
FILE *pipe = popen(cmd_ptr, "w");
if (!pipe) {
  status = 1;
} else {
  u32 input_ptr = input.val < 0 ? (u32)(i32)input.val : (u32)input.val;
  if ((i32)inputType.val == 195) {
    i32 len = *((i32*)(MEM + input_ptr));
    fwrite(MEM + input_ptr + 4, 1, (size_t)len, pipe);
  } else if ((i32)inputType.val == 67) {
    i32 len = *((i32*)(MEM + input_ptr));
    for (i32 i = 0; i < len; i++) fputc((char)(*((u16*)(MEM + input_ptr + 4 + i * 2)) & 0xff), pipe);
  }
  status = pclose(pipe);
}
if (cmd_owned) free(cmd_owned);
`;
	}

	if (status !== 0) throw new Error('execSync failed');
};

const __porffor_execFile = (cmd, args, envArr, cwd, input, mode) => {
	const cmdType = Porffor.type(cmd);
	const envType = Porffor.type(envArr);
	const cwdType = Porffor.type(cwd);
	const inputType = Porffor.type(input);
	let status = 0;
	let outLen = 0,
		outBuf = 0,
		errLen = 0,
		errBuf = 0;

	Porffor.c`
{
  signal(SIGPIPE, SIG_IGN);
  char *cmd_owned;
  char *cmd_ptr = __porffor_node_cstr(MEM, cmd, (i32)cmdType.val, &cmd_owned);

  const u32 arr = args.val < 0 ? (u32)(i32)args.val : (u32)args.val;
  const i32 argn = *((i32*)(MEM + arr));
  const u32 ent = *((u32*)(MEM + arr + 4));
  char **cargv = calloc((size_t)argn + 2, sizeof(char*));
  char **argown = calloc((size_t)argn + 2, sizeof(char*));
  cargv[0] = cmd_ptr;
  for (i32 i = 0; i < argn; i++) {
    const jsval av = porf_unpack(*(jsbits*)(MEM + ent + (u64)i * 8));
    cargv[i + 1] = __porffor_node_cstr(MEM, av, porf_jv_type(av), &argown[i + 1]);
  }

  char **cenv = NULL;
  char **envown = NULL;
  i32 envn = 0;
  if ((i32)envType.val == 72) {
    const u32 earr = envArr.val < 0 ? (u32)(i32)envArr.val : (u32)envArr.val;
    envn = *((i32*)(MEM + earr));
    const u32 eent = *((u32*)(MEM + earr + 4));
    cenv = calloc((size_t)envn + 1, sizeof(char*));
    envown = calloc((size_t)envn + 1, sizeof(char*));
    for (i32 i = 0; i < envn; i++) {
      const jsval ev = porf_unpack(*(jsbits*)(MEM + eent + (u64)i * 8));
      cenv[i] = __porffor_node_cstr(MEM, ev, porf_jv_type(ev), &envown[i]);
    }
  }

  char *cwd_owned = NULL;
  char *cwd_ptr = NULL;
  if ((i32)cwdType.val != 0) cwd_ptr = __porffor_node_cstr(MEM, cwd, (i32)cwdType.val, &cwd_owned);

  // stdout/stderr go via temp files (no pipe deadlock); stdin via a pipe
  const int capture = (i32)mode.val == 0;
  char outtmp[] = "/tmp/porffor-exec-out-XXXXXX";
  char errtmp[] = "/tmp/porffor-exec-err-XXXXXX";
  int outfd = -1, errfd = -1;
  if (capture) {
    outfd = mkstemp(outtmp);
    errfd = mkstemp(errtmp);
  }
  int inpipe[2];
  if (pipe(inpipe) != 0) {
    status = -1;
  } else {
    const pid_t pid = fork();
    if (pid == 0) {
      if (cwd_ptr && chdir(cwd_ptr) != 0) _exit(127);
      dup2(inpipe[0], 0);
      close(inpipe[0]);
      close(inpipe[1]);
      if (capture) {
        dup2(outfd, 1);
        dup2(errfd, 2);
      } else if ((i32)mode.val == 2) {
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);
      }
      if (cenv) {
        extern char **environ;
        environ = cenv;
      }
      execvp(cmd_ptr, cargv);
      _exit(127);
    }
    close(inpipe[0]);
    if (pid < 0) {
      close(inpipe[1]);
      status = -1;
    } else {
      if ((i32)inputType.val != 0) {
        FILE *inf = fdopen(inpipe[1], "w");
        if (inf) {
          const u32 input_ptr = input.val < 0 ? (u32)(i32)input.val : (u32)input.val;
          if ((i32)inputType.val == 195) fwrite(MEM + input_ptr + 4, 1, (size_t)*((i32*)(MEM + input_ptr)), inf);
            else if ((i32)inputType.val == 67) __porffor_write_utf8(inf, MEM, input_ptr);
          fclose(inf);
        } else close(inpipe[1]);
      } else close(inpipe[1]);

      int child_status = 0;
      if (waitpid(pid, &child_status, 0) < 0) status = -1;
        else if (WIFEXITED(child_status)) status = WEXITSTATUS(child_status);
        else status = 128 + (WIFSIGNALED(child_status) ? WTERMSIG(child_status) : 0);
    }
  }

  if (capture) {
    for (int which = 0; which < 2; which++) {
      const int fd = which == 0 ? outfd : errfd;
      if (fd < 0) continue;
      const off_t sz = lseek(fd, 0, SEEK_END);
      lseek(fd, 0, SEEK_SET);
      char *tmp = malloc(sz > 0 ? (size_t)sz : 1);
      i32 got = 0;
      if (tmp && sz > 0) {
        ssize_t n;
        while (got < (i32)sz && (n = read(fd, tmp + got, (size_t)sz - (size_t)got)) > 0) got += (i32)n;
      }
      if (which == 0) { outBuf = (f64)(u64)tmp; outLen = got; }
        else { errBuf = (f64)(u64)tmp; errLen = got; }
      close(fd);
    }
    unlink(outtmp);
    unlink(errtmp);
  }

  for (i32 i = 0; i < argn + 2; i++) if (argown && argown[i]) free(argown[i]);
  if (envown) for (i32 i = 0; i < envn; i++) if (envown[i]) free(envown[i]);
  free(cargv);
  free(argown);
  if (cenv) free(cenv);
  if (envown) free(envown);
  if (cwd_owned) free(cwd_owned);
  if (cmd_owned) free(cmd_owned);
}
`;

	const takeBuf = (len, buf) => {
		const out = Porffor.malloc(len + 6);
		Porffor.c`
u32 out_ptr = out.val < 0 ? (u32)(i32)out.val : (u32)out.val;
*((i32*)(MEM + out_ptr)) = (i32)len.val;
if ((i32)len.val > 0) memcpy(MEM + out_ptr + 4, (void*)(u64)buf.val, (size_t)len.val);
if (buf.val != 0) free((void*)(u64)buf.val);
*(MEM + out_ptr + 4 + (i32)len.val) = 0;
`;
		return Porffor.as(out, Porffor.TYPES.bytestring);
	};

	return { status, stdout: takeBuf(outLen, outBuf), stderr: takeBuf(errLen, errBuf) };
};

const __porffor_utf8OrBytes = (data) => {
	let units = 0;
	Porffor.c`units = __porffor_utf8_units(MEM, data, 195);`;
	if (units < 0) return data;

	const str = Porffor.malloc(units * 2 + 6);
	Porffor.c`
u32 str_ptr = str.val < 0 ? (u32)(i32)str.val : (u32)str.val;
*((i32*)(MEM + str_ptr)) = (i32)units;
__porffor_utf8_decode(MEM, data, 195, str);
`;
	return Porffor.as(str, Porffor.TYPES.string);
};

export const execFileSync = (cmd, args = [], options = {}) => {
	let mode = 0; // 0 capture, 1 inherit, 2 ignore
	const stdio = options.stdio;
	if (stdio === 'inherit') mode = 1;
	else if (stdio === 'ignore') mode = 2;
	else if (Porffor.type(stdio) == Porffor.TYPES.array) {
		if (stdio[1] === 'inherit') mode = 1;
		else if (stdio[1] === 'ignore') mode = 2;
	}

	let envArr = undefined;
	if (options.env != null) {
		envArr = [];
		const keys = Object.keys(options.env);
		for (let i = 0; i < keys.length; i++) {
			envArr.push(keys[i] + '=' + options.env[keys[i]]);
		}
	}

	const res = __porffor_execFile(cmd, args, envArr, options.cwd, options.input, mode);

	let stdout = res.stdout;
	let stderr = res.stderr;
	if (options.encoding !== undefined) {
		stdout = __porffor_utf8OrBytes(stdout);
		stderr = __porffor_utf8OrBytes(stderr);
	}

	if (res.status != 0) {
		const e = new Error('Command failed: ' + cmd + ' (status ' + res.status + ')');
		e.status = res.status;
		e.stdout = stdout;
		e.stderr = stderr;
		if (res.status == 127) e.code = 'ENOENT';
		throw e;
	}

	return stdout;
};
