import { spawn } from "node:child_process";
import path from "node:path";

export interface MasterlinkReadProbe {
  /** true = connector odczytał bazę MasterLink; false = źródło niedostępne. Nigdy nie rzuca. */
  check(signal?: AbortSignal): Promise<boolean>;
}

/**
 * Sprawdza odczyt MasterLink tym samym kodem i tą samą konfiguracją (`ML_ENV_FILE`), których
 * używa serwer MCP. Osobny proces: runtime BOK nie ładuje sekretów bazy ani sterownika `pg`.
 */
export class ConnectorMasterlinkReadProbe implements MasterlinkReadProbe {
  constructor(
    private readonly projectDir: string,
    private readonly envFile: string,
    private readonly timeoutMs = 20_000,
  ) {}

  check(signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", path.join(this.projectDir, "dist/read-probe.js")],
          {
            cwd: this.projectDir,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: process.env.HOME ?? "",
              ML_ENV_FILE: this.envFile,
            },
            stdio: "ignore",
            timeout: this.timeoutMs,
            ...(signal ? { signal } : {}),
          },
        );
      } catch {
        resolve(false);
        return;
      }
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
  }
}
