# raft-node

A Node.js implementation of the Raft consensus algorithm for a simple distributed key-value store.

## Run Raft cluster

Install dependencies:
```bash
npm install
```

Start a Raft cluster:
```bash
npm start

# or pass the number of nodes in the cluster
npm start 5
```

Key-value ports start from 5000 and increment by 1 for each node in the cluster.

### Accessing the key-value store

After starting the cluster, you can set/get keys using the leader's HTTP address. In the cluster logs look for the current leader's index and make a `/set` request to it. E.g. if the leader index is 1, use `http://localhost:5001`.

```bash
curl -X POST http://localhost:5001/set\?key\=a\&value\=1
```

This should replicate the key-value pair to the followers and return a response with `Done`.

Then you can get the value of the key using `/get`:

```bash
curl http://localhost:5001/get\?key\=a # should return 1
```

The value for key `a` should be `1` across all nodes in the cluster, e.g. try calling `/get` on `http://localhost:5000` and `http://localhost:5001`.

```bash
curl http://localhost:5000/get\?key\=a # should return 1
curl http://localhost:5001/get\?key\=a # should return 1
```