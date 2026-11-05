import fs from "node:fs";
import path from "node:path";

/**
 * The error dialogs of a start that cannot complete, in Chinese and English: they appear before the window (and its
 * language setting) exists. Pure text builders plus the data folder check, so that both are testable without Electron.
 */
export interface StartupDialog { title: string; message: string }

const reason = (error: unknown) => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
};

/**
 * Creates the data root and its runtime folder and proves that both can be written (a folder that already exists on a
 * read-only volume or with the wrong owner passes mkdir). Returns the error, or null when the data root is usable.
 */
export function prepareDataRoot(paths: { root: string; runtime: string }, files: Pick<typeof fs, "mkdirSync" | "writeFileSync" | "rmSync"> = fs): unknown {
  try {
    files.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    // The frozen queue and the recipe store require their owned runtime root to exist before they load.
    files.mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
    for (const folder of [paths.root, paths.runtime]) {
      const probe = path.join(folder, `.write-check-${process.pid}`);
      files.writeFileSync(probe, "", { flag: "w", mode: 0o600 });
      files.rmSync(probe, { force: true });
    }
    return null;
  } catch (error) {
    return error;
  }
}

/** The data root cannot be created or written: nothing has been read or changed yet. */
export function dataRootFailureDialog(root: string, error: unknown, fromEnvironment: boolean): StartupDialog {
  const source = fromEnvironment
    ? { zh: "（由环境变量 NOVELAI_DATA_DIR 指定）", en: " (set by the environment variable NOVELAI_DATA_DIR)" }
    : { zh: "", en: "" };
  return {
    title: "数据文件夹不可用 / Data folder not usable",
    message: [
      `MCP for NovelAI 无法在数据文件夹中创建或写入文件，因此没有启动。`,
      `数据文件夹${source.zh}：${root}`,
      `原因：${reason(error)}`,
      `请确认这个位置存在且可写（不在只读磁盘上，当前用户有写入权限），或用环境变量 NOVELAI_DATA_DIR 指定另一个可写的文件夹，然后重新启动。`,
      "",
      `MCP for NovelAI cannot create or write files in its data folder, so it did not start.`,
      `Data folder${source.en}: ${root}`,
      `Reason: ${reason(error)}`,
      `Make sure this location exists and is writable (not on a read-only disk, and your user may write to it), or set the environment variable NOVELAI_DATA_DIR to another writable folder, then start the app again.`,
    ].join("\n"),
  };
}

/** Where a start stopped: opening the library (and Recently Deleted), starting the MCP bridge, or any other step. */
export type StartupStep = "library" | "bridge" | "startup";

export function startupFailureDialog(step: StartupStep, error: unknown, runtimeFolder: string): StartupDialog {
  const detail = reason(error);
  if (step === "library") return {
    title: "素材库未能打开 / Library could not be opened",
    message: [
      `素材库或“最近删除”未能打开，启动没有完成。原有文件已保留。请先解决下面的错误再重新启动；不要删除或替换 library.sqlite，没有它时下次启动会新建一个空的素材库。`,
      `原因：${detail}`,
      "",
      `The library or Recently Deleted could not be opened, so the app did not finish starting. Your files were left as they were. Fix the error below before starting again; do not delete or replace library.sqlite: without it, the next start creates a new, empty library.`,
      `Reason: ${detail}`,
    ].join("\n"),
  };
  if (step === "bridge") return {
    title: "AI 接入服务未能启动 / AI access could not start",
    message: [
      `AI 接入服务（供 MCP 服务连接本应用的本机桥接）未能启动，启动没有完成。原有文件已保留。`,
      `请确认没有另一个 MCP for NovelAI 仍在运行，并检查运行文件夹可写：${runtimeFolder}`,
      `原因：${detail}`,
      "",
      `The AI access bridge (the local connection the MCP server uses to reach this app) could not start, so the app did not finish starting. Your files were left as they were.`,
      `Make sure no other MCP for NovelAI is still running, and that the runtime folder is writable: ${runtimeFolder}`,
      `Reason: ${detail}`,
    ].join("\n"),
  };
  return {
    title: "启动未完成 / Startup did not complete",
    message: [
      `MCP for NovelAI 未能完成启动。原有文件已保留。请先解决下面的错误再重新启动。`,
      `原因：${detail}`,
      "",
      `MCP for NovelAI could not finish starting. Your files were left as they were. Fix the error below before starting again.`,
      `Reason: ${detail}`,
    ].join("\n"),
  };
}
