import { ChildProcess, fork } from "node:child_process";

export class RaftCluster {
  nodeProcesses: ChildProcess[] = [];

  constructor(nNodes: number = 3) {
    const serverPorts = new Array(nNodes).fill(0).map((_, i) => 5000 + i);
    const raftPorts = new Array(nNodes).fill(0).map((_, i) => 7000 + i);
    const raftAddresses = raftPorts.map((p) => `http://localhost:${p}`);
    console.log(serverPorts, raftAddresses);
    serverPorts.forEach((port, i) => {
      this.nodeProcesses.push(
        fork(
          "src/start-node.ts",
          [port.toString(), i.toString(), raftAddresses.join(",")],
          {
            execArgv: ["-r", "ts-node/register"],
            stdio: "inherit",
          }
        )
      );
    });
  }
}

new RaftCluster(Number(process.argv[2] || "3"));
