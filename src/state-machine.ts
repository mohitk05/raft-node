// A simple kv store

import { LogEntry, LogType } from "./node";

export class Store {
  private state: Record<string, string>;

  constructor() {
    this.state = {};
  }

  apply(logs: LogEntry[]) {
    logs.forEach((log) => {
      console.log("Applying", log);
      switch (log.type) {
        case LogType.Set:
          this.state[log.args[0]] = log.args[1];
          break;
        case LogType.Del:
          delete this.state[log.args[0]];
          break;
      }
    });
  }

  get(key: string) {
    return this.state[key];
  }
}
