import * as express from "express";
import { Store } from "./state-machine";

enum State {
  Follower,
  Candidate,
  Leader,
}

export interface ServerConfig {
  address: string;
  port: number;
  index: number;
}

export enum LogType {
  Beat = "Beat",
  Set = "Set",
  Del = "Del",
}

export interface LogEntry {
  type: LogType;
  args: string[];
  index: number;
  term: number;
}

interface AppendEntriesParams {
  term: number;
  leaderId: number;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
}

interface RequestVoteParams {
  term: number;
  candidateId: number;
  lastLogIndex: number;
  lastLogTerm: number;
}

const APPEND_ENTRIES_PATH = "/append-entries",
  REQUEST_VOTE_PATH = "/request-vote";

export class RaftNode {
  state: State = State.Follower;
  currentTerm: number = 0;
  votedFor: number | null = null;
  log: LogEntry[] = [];

  // volatile
  commitIndex: number = 0;
  lastApplied: number = 0;

  // for servers
  nextIndex: Record<number, number>;
  matchIndex: Record<number, number>;

  // internals
  private _index: number;
  private _servers: ServerConfig[];
  private _store: Store;
  private _expressRaft: express.Express = express();
  private _expressKV: express.Express = express();
  private _portKV: number;
  private _raftPort: number;
  private _leaderElectionTimeout: NodeJS.Timeout | null = null;
  private _heartbeatTimeout: NodeJS.Timeout | null = null;

  constructor({
    port,
    index,
    servers,
  }: {
    port: number;
    index: number;
    servers: ServerConfig[];
  }) {
    this._index = index;
    this._servers = servers;
    this._portKV = port;
    this._raftPort = servers[index].port;

    this.log.push({
      type: LogType.Beat,
      args: [],
      index: this.log.length,
      term: this.currentTerm,
    });

    this._store = new Store();
    console.log(port, index, servers);
    this.setupRaftHandler();
    this._expressRaft.listen(this._raftPort, () => {
      this.logToConsole("Started raft server");
      this.resetLeaderElectionTimeout();
    });

    this.setupKVHandler();
    this._expressKV.listen(this._portKV, () => {
      this.logToConsole("Started KV server");
    });
  }

  cleanup() {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
    }

    if (this._leaderElectionTimeout) {
      clearTimeout(this._leaderElectionTimeout);
    }
  }

  private logToConsole(...args: unknown[]) {
    console.log(`Node ${this._index}: `, ...args);
  }

  get address() {
    return `http://localhost:${this._portKV}`;
  }

  private setupKVHandler() {
    this._expressKV.use(express.json());
    this._expressKV.get("/get", (req, res) => {
      const key = req.query.key as string;
      if (!key) {
        res.status(400).send("Key not provided");
      }
      this.logToConsole(this._store.get(key));
      res.send({
        data: this._store.get(key) || "",
      });
    });

    this._expressKV.post("/set", async (req, res) => {
      if (this.state !== State.Leader) {
        res.status(400).send("This node is not the leader, cannot set");
        return;
      }
      const key = req.query.key as string,
        value = req.query.value as string;
      if (!key || !value) {
        res.status(400).send("Key and value required");
        return;
      }

      const entry: LogEntry = {
        type: LogType.Set,
        args: [key, value],
        index: this.log.length,
        term: this.currentTerm,
      };

      const result = await this.rpcAppendEntries([entry]);
      this.log.push(entry);
      this.logToConsole("/set", result);
      if (result) {
        this._store.apply([entry]);
        this.logToConsole("/set", this._store.get(key));
      }

      res.send("Done");
    });
  }

  private setupRaftHandler() {
    this._expressRaft.use(express.json());
    this._expressRaft.post<{}, {}, AppendEntriesParams>(
      APPEND_ENTRIES_PATH,
      (req, res) => {
        const result = this.AppendEntries(req.body);
        res.send(result);
      }
    );
    this._expressRaft.post<{}, {}, RequestVoteParams>(
      REQUEST_VOTE_PATH,
      (req, res) => {
        const result = this.RequestVote(req.body);
        res.send(result);
      }
    );
  }

  private async heartbeat() {
    this._heartbeatTimeout = setTimeout(() => {
      this.heartbeat();
    }, 500);
    this.rpcAppendEntries([
      {
        type: LogType.Beat,
        args: [],
        index: this.log.length,
        term: this.currentTerm,
      },
    ]);
  }

  private async rpcAppendEntries(entries: LogEntry[]) {
    if (this.state !== State.Leader) return false;
    const results = await Promise.all<{
      term: number;
      success: boolean;
    }>(
      this._servers
        .filter((s, i) => i !== this._index)
        .map((s) =>
          fetch(s.address + APPEND_ENTRIES_PATH, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              term: this.currentTerm,
              leaderId: this._index,
              prevLogIndex: this.log[this.log.length - 1].index,
              prevLogTerm: this.log[this.log.length - 1].term,
              entries,
              leaderCommit: this.commitIndex,
            }),
          })
            .then((res) => res.json())
            .catch(() => ({ success: false }))
        )
    );

    return results.every((r) => r.success);
  }

  private async rpcRequestVote() {
    if (this.state !== State.Candidate) return false;
    const results = await Promise.all<{
      term: number;
      voteGranted: boolean;
    }>(
      this._servers
        .filter((s, i) => i !== this._index)
        .map((s) =>
          fetch(s.address + REQUEST_VOTE_PATH, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              term: this.currentTerm,
              candidateId: this._index,
              lastLogIndex: this.log.length - 1,
              lastLogTerm: this.log[this.log.length - 1].term,
            }),
          })
            .then((res) => res.json())
            .catch(() => ({ voteGranted: null }))
        )
    );

    // self vote
    results.push({ term: this.currentTerm, voteGranted: true });

    this.logToConsole("rpcRequestVote", results);
    return (
      results.filter((r) => r.voteGranted !== null).filter((r) => r.voteGranted)
        .length >
      this._servers.length / 2
    );
  }

  private moveToLeader() {
    this.logToConsole("Moved to leader");
    this.state = State.Leader;
    this.heartbeat();
  }

  private async moveToCandidate() {
    this.logToConsole("Moved to candidate");
    this.state = State.Candidate;
    this.currentTerm++;
    const result = await this.rpcRequestVote();
    if (result) {
      this.moveToLeader();
    } else {
      this.state = State.Follower;
      this.resetLeaderElectionTimeout();
      this.logToConsole("Moved back to follower");
    }
  }

  private async resetLeaderElectionTimeout() {
    if (this._leaderElectionTimeout) clearTimeout(this._leaderElectionTimeout);
    this._leaderElectionTimeout = setTimeout(() => {
      this.moveToCandidate();
    }, 1000 + Math.random() * 500);
  }

  private AppendEntries({
    term,
    leaderId,
    prevLogIndex,
    prevLogTerm,
    entries,
    leaderCommit,
  }: AppendEntriesParams): { term: number; success: boolean } {
    this.logToConsole("AppendEntries", entries);
    if (term === this.currentTerm && this.state === State.Candidate) {
      this.state = State.Follower;
    }

    this.resetLeaderElectionTimeout();

    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    if (
      !this.log[prevLogIndex] ||
      this.log[prevLogIndex].term !== prevLogTerm
    ) {
      return { term: this.currentTerm, success: false };
    }

    if (!entries.filter((e) => e.type !== LogType.Beat).length) {
      // simple heartbeat
      return { term: this.currentTerm, success: true };
    }

    this.log.push(...entries);
    this._store.apply(entries);
    this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
    return { term: this.currentTerm, success: true };
  }

  private RequestVote({
    term,
    candidateId,
    lastLogIndex,
    lastLogTerm,
  }: RequestVoteParams): { term: number; voteGranted: boolean } {
    this.logToConsole(
      "RequestVote",
      term,
      this.currentTerm,
      candidateId,
      lastLogIndex,
      lastLogTerm,
      this.log.length - 1
    );

    if (term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }

    const oldTerm = this.currentTerm;

    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.state = State.Follower;
      if (this._leaderElectionTimeout)
        clearTimeout(this._leaderElectionTimeout);
    }

    if (
      !this.votedFor &&
      !(
        lastLogTerm > this.log[this.log.length - 1].term ||
        (lastLogTerm === this.log[this.log.length - 1].term &&
          lastLogIndex >= this.log.length - 1)
      )
    ) {
      return {
        term: this.currentTerm,
        voteGranted: false,
      };
    }

    if (this.votedFor && term === oldTerm) {
      return {
        term: this.currentTerm,
        voteGranted: false,
      };
    }

    this.votedFor = candidateId;

    return {
      term: this.currentTerm,
      voteGranted: true,
    };
  }
}
