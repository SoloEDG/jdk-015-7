/** A failure that can be located to one or more ranges of the selected track. */
export interface ExportInterval {
  /** Absolute position in the selected track, in seconds. */
  start: number;
  end: number;
}

export class ExportIntervalError extends Error {
  readonly intervals: ExportInterval[];
  /** Frames of the export that could not be rendered, when applicable. */
  frameRange?: { start: number; end: number };
  constructor(message: string, intervals: ExportInterval[]) {
    super(message);
    this.name = "ExportIntervalError";
    this.intervals = intervals;
  }
}

export class ExportCancelledError extends Error {
  constructor() {
    super("导出已取消");
    this.name = "ExportCancelledError";
  }
}
