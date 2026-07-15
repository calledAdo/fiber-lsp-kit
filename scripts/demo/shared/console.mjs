const RESET = "\u001b[0m";
const COLORS = {
  ok: "\u001b[32m",
  run: "\u001b[36m",
  info: "\u001b[34m",
  warn: "\u001b[33m",
  fail: "\u001b[31m",
};

const MARKERS = {
  ok: "[ OK ]",
  run: "[RUN ]",
  info: "[INFO]",
  warn: "[WARN]",
  fail: "[FAIL]",
};

function defaultColor() {
  return Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env);
}

function suffix(detail) {
  return detail === undefined || detail === "" ? "" : ` \u00b7 ${detail}`;
}

export function shortId(value) {
  const text = String(value ?? "");
  return text.length > 22 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

export function createDemoConsole({ color = defaultColor(), write = console.log } = {}) {
  const line = (kind, message, detail) => {
    const marker = color ? `${COLORS[kind]}${MARKERS[kind]}${RESET}` : MARKERS[kind];
    write(`${marker} ${message}${suffix(detail)}`);
  };

  return {
    heading(name, role) {
      write(role ? `${name} / ${role}` : name);
    },
    ok(message, detail) {
      line("ok", message, detail);
    },
    run(message, detail) {
      line("run", message, detail);
    },
    info(message, detail) {
      line("info", message, detail);
    },
    warn(message, detail) {
      line("warn", message, detail);
    },
    fail(message, detail) {
      line("fail", message, detail);
    },
    detail(message) {
      write(`       ${message}`);
    },
    raw(message = "") {
      write(message);
    },
  };
}

export const demoConsole = createDemoConsole();
