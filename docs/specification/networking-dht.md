# TON Distributed Hash Table (DHT) Sub-Specification

## 1. Overview & Architectural Scope

The TON Distributed Hash Table (DHT) provides a decentralized, fault-tolerant lookup and directory service for the TON network stack. It sits directly above the Abstract Datagram Network Layer (ADNL) and serves as the primary mechanism for peer discovery, service registration, and tunnel entry point allocation without relying on central authorities.

### Key Responsies
* **Node Discovery**: Mapping 256-bit ADNL Node IDs to reachable IP addresses, UDP ports, and network capabilities.
* **Service Resolution**: Mapping service identifiers to candidate ADNL nodes capable of serving those requests.
* **Tunnel & Proxy Entry Point Allocation**: Mapping overlay networks or tunnel descriptors to active proxy nodes for anonymous or NAT-traversing network circuits.

### Relationship to ADNL
The DHT layer relies on ADNL for secure, encrypted point-to-point datagram transport and peer identification. Node addresses in the DHT are defined using ADNL Node IDs (256-bit cryptographic hashes of node public keys). For full details on ADNL address generation, handshakes, and packet encodings, see [`networking-adnl.md`](networking-adnl.md).

---

## 2. Key Space & Distance Metric

### Key Space
The DHT operates over a 256-bit key space ($2^{256}$). All keys—whether representing nodes, stored values, services, or tunnel entry points—are formatted as uniform 256-bit (32-byte) bitstrings.

### XOR Distance Metric
Distance between two 256-bit identifiers $x$ and $y$ is defined using the bitwise XOR operation:

$$d(x, y) = x \oplus y$$

#### Mathematical Properties
1. **Symmetry**: $d(x, y) = d(y, x)$
2. **Identity**: $d(x, y) = 0 \iff x = y$
3. **Unidirectionality**: For any target $x$ and distance $\Delta > 0$, there exists exactly one point $y$ such that $d(x, y) = \Delta$.
4. **Triangle Inequality**: $d(x, z) \le d(x, y) \oplus d(y, z)$

### Key Derivation Rules
* **Node Keys**: Equal to the 256-bit ADNL Node ID (`SHA-256` hash of the serialized ADNL public key descriptor).
* **Service Keys**: `SHA-256` hash of the canonical service descriptor string or TL-serialized service ID.
* **Tunnel & Overlay Keys**: `SHA-256` hash of the overlay network ID or tunnel target specification.

---

## 3. Data Model & Stored Value Types

### Value Specification Structure
Stored entries in the DHT follow a structured, self-verifying format (`dht.value`) containing a key description, data payload, TTL, and signature.

```
dht.keyDescription key:int256 id:PublicKey update_rule:dht.UpdateRule signature:bytes = dht.KeyDescription;

dht.value key_description:dht.KeyDescription value:bytes ttl:int32 signature:bytes = dht.Value;
```

#### Field Definitions
* **`key_description`**: Defines the target key, the owner's public key (`id`), the update validation rule, and a signature over the description by the owner.
* **`value`**: The opaque binary payload (capped at a maximum size of 2048 bytes).
* **`ttl`**: Unix timestamp (in seconds) specifying when the record expires and may be garbage-collected by storing nodes.
* **`signature`**: Cryptographic signature over `SHA-256(value || ttl)` created using the private key corresponding to `key_description.id`.

### Update Rules (`dht.UpdateRule`)
1. **`dht.updateRule.signature`**: Only updates signed by the private key corresponding to `key_description.id` are accepted.
2. **`dht.updateRule.anybody`**: Any valid payload matching the key description can update the entry (used for public counter or multi-provider aggregations).
3. **`dht.updateRule.overlay`**: Special validation rules enforced for overlay network member lists.

---

## 4. Primary Use Cases & Value Payloads

### 1. Node Location Records (`dht.node`)
Maps a node's 256-bit ADNL Node ID to its physical network endpoints.

* **Target Key**: 256-bit ADNL Node ID.
* **Payload Structure (`dht.node`)**:
  * `id`: Public key of the ADNL node.
  * `addr_list`: List of network addresses (IPv4 / IPv6 addresses, UDP port numbers).
  * `version`: Unix timestamp of record creation.
  * `signature`: Signature over `addr_list` and `version` by the node's private key.

### 2. Service Directory Records
Maps functional service identifiers (e.g., validator services, storage nodes, RPC providers) to active ADNL Node IDs.

* **Target Key**: `SHA-256("service:" || service_name || params)`
* **Payload Structure**: List of active provider ADNL Node IDs, operational flags, priority weights, and expiration metadata.

### 3. Tunnel & Proxy Entry Points
Enables anonymous routing and NAT traversal by maintaining lists of relay nodes capable of proxying ADNL traffic.

* **Target Key**: `SHA-256("tunnel:" || target_node_id)` or `SHA-256("proxy:" || group_id)`
* **Payload Structure**: List of proxy ADNL Node IDs, supported transport protocols, bandwidth capabilities, and relay authentication parameters.

---

## 5. Routing Table & K-Bucket Management

### Routing Table Structure
Each node maintains a routing table organized into 256 $K$-buckets (where $K = 20$).

* Bucket $i$ ($0 \le i < 256$) contains contact information for nodes whose XOR distance from the local node falls in the range $[2^i, 2^{i+1} - 1]$.
* Each contact entry stores:
  * **Node ID**: 256-bit ADNL address.
  * **Network Address**: IP address and UDP port.
  * **Last Seen**: Timestamp of last successful ADNL ping or RPC exchange.
  * **Liveness State**: Active, Stale, or Questionable.

### Bucket Maintenance & Eviction Policy
1. **Least-Recently Seen Eviction**: When bucket $i$ is full and a new candidate node is discovered, the local node pings (`dht.ping`) the least-recently seen contact in bucket $i$.
2. **Eviction Rule**:
   * If the old contact responds, it is moved to the tail of the bucket (marked most-recently seen), and the candidate node is discarded (or held in a secondary replacement cache).
   * If the old contact fails to respond within the timeout, it is evicted, and the candidate node is added to the bucket.
3. **Replacement Caches**: Each bucket maintains a replacement cache of up to $K$ extra candidate nodes to rapidly refill buckets if multiple contacts become unreachable.

### Bootstrapping Process
1. Upon joining the network, a node populates its routing table with hardcoded or configured **bootstrap nodes**.
2. The node issues an iterative `dht.findNode` query searching for its own 256-bit ADNL Node ID.
3. As responses arrive, the node populates its $K$-buckets across all prefix distances and learns about neighboring nodes closest to itself.
4. The node periodically refreshes buckets that have not been queried within a refresh threshold (e.g., 1 hour).

---

## 6. DHT RPC Operations

DHT communication occurs via ADNL RPC queries over UDP.

### RPC Messages

#### `dht.ping` / `dht.pong`
* **`dht.ping`**: Parameter `random_id:int64`. Used for liveness verification.
* **`dht.pong`**: Returns `random_id:int64` matching the request.

#### `dht.findNode`
* **Query**: `key:int256`, `k:int32` (typically $k = 20$).
* **Response**: `dht.nodes nodes:vector<dht.nodeInfo>` containing up to $K$ closest nodes to `key` known to the target node.

#### `dht.findValue`
* **Query**: `key:int256`, `k:int32`.
* **Response**:
  * **Found**: `dht.valueFound value:dht.value nodes:vector<dht.nodeInfo>` returning the stored value plus $K$ closest nodes.
  * **Not Found**: `dht.valueNotFound nodes:vector<dht.nodeInfo>` returning $K$ closest nodes to `key`.

#### `dht.store`
* **Query**: `value:dht.value`.
* **Response**: `dht.stored` confirmation or error code (e.g., invalid signature, TTL exceeded, payload size limit exceeded).

### Iterative Lookup Algorithm
To execute `dht.findNode` or `dht.findValue`:
1. **Initialization**: Select the $\alpha$ (concurrency parameter, $\alpha = 3$) closest nodes to target `key` from local $K$-buckets.
2. **Parallel Queries**: Send concurrent `dht.findNode` or `dht.findValue` queries to the $\alpha$ nodes.
3. **Dynamic Step**:
   * As responses return, track the $K$ closest nodes discovered so far.
   * Send queries to newly discovered nodes that are closer than any previously queried node.
4. **Termination**: The lookup terminates when queries have been sent to all $K$ closest known nodes without discovering any closer candidates, or upon timeout.
5. **Value Caching**: When `dht.findValue` succeeds, the caller stores the retrieved value at the closest node discovered during the search that did *not* return the value, reducing lookup latency for subsequent queries.

---

## 7. Security, Validation & Anti-Abuse

### Cryptographic Self-Verification
All stored values are self-verifying:
* Storing nodes MUST check that `key_description.signature` is valid for `key_description.id`.
* Storing nodes MUST verify `dht.value.signature` against `key_description.id`.
* Updates violating the update rule specified in `key_description.update_rule` MUST be rejected.

### Resource Limits
* **Maximum Value Size**: Payloads exceeding 2048 bytes are rejected to prevent storage amplification attacks.
* **Maximum TTL**: TTL values cannot exceed 86,400 seconds (24 hours). Publishers must periodically re-store active records.
* **Rate Limiting**: Nodes enforce token-bucket rate limits on inbound DHT queries per source IP / ADNL address to mitigate Denial of Service (DoS) attacks.

### Anti-Sybil Mechanisms
* Nodes validate that contact IP addresses returned in node records are routable and pass basic IP diversity checks to minimize susceptibility to Sybil and Eclipse attacks.
