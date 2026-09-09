# ADR 0002: Kademlia-Based Distributed Hash Table (DHT) for Decentralized Discovery

* **Status**: Accepted
* **Date**: 2026-08-03
* **Sub-system**: Networking Layer (DHT)

---

## Context

In the TON peer-to-peer network architecture, nodes are identified cryptographically by 256-bit ADNL Node IDs (derived from the SHA-256 hash of their public keys). To establish ADNL channels and exchange messages, nodes must discover the physical IP addresses and UDP ports of target peers. Furthermore, the ecosystem requires a decentralized mechanism to locate specific network services (such as validator endpoints, storage nodes, or RPC gateways) and anonymous proxy/tunnel entry points without relying on centralized DNS, static registries, or single points of failure.

A lookup system in this environment must meet the following requirements:
1. **Decentralization & Unstoppability**: Operating without central servers or trusted coordinators.
2. **Cryptographic Verifiability**: Ensuring data records (such as IP mapping or proxy entry points) cannot be forged or tampered with by intermediary routing nodes.
3. **Scalability**: Supporting logarithmic scaling $O(\log N)$ for routing lookup overhead across millions of nodes.
4. **Integration with ADNL**: Utilizing 256-bit Node IDs and ADNL datagram RPC primitives for seamless transport integration.

---

## Decision

We adopt a **256-bit Kademlia-like Distributed Hash Table (DHT)** as the standard discovery sub-specification for the TON network layer, operating over ADNL RPC.

### Key Aspects of the Architecture
1. **256-bit Key Space & XOR Metric**: Keys and Node IDs exist in the same 256-bit space ($2^{256}$). Distance between keys $x$ and $y$ is computed using the symmetric XOR metric $d(x, y) = x \oplus y$.
2. **$K$-Bucket Routing Table**: Each node maintains 256 $K$-buckets ($K=20$) containing contact details for peers categorized by prefix XOR distance, refreshed via least-recently-seen eviction and ping mechanisms.
3. **Self-Verifying Data Model (`dht.value`)**: Stored records must contain a `key_description` and owner signature (`dht.value`). Storing nodes cryptographically validate payloads against the owner's public key before accepting stores or updates.
4. **Three Primary Storage Use Cases**:
   * **Node Location (`dht.node`)**: Mapping 256-bit ADNL Node IDs to IP:Port endpoints.
   * **Service Directory**: Mapping hashed service identifiers to active ADNL provider nodes.
   * **Tunnel Entry Points**: Mapping tunnel/overlay IDs to active proxy relay endpoints.
5. **Iterative Lookup Protocol**: Parallel lookup routines ($\alpha = 3$) for `dht.findNode` and `dht.findValue` over ADNL datagram RPCs, accompanied by caching on intermediate nodes upon successful lookup.

---

## Consequences

### Positive
* **Decentralized & Autonomous**: Enables peer-to-peer lookup and discovery with zero reliance on centralized infrastructure or domain registrars.
* **Tamper-Proof & Secure**: Cryptographic signatures on `dht.value` prevent unauthorized record mutation or spoofing of node location records by arbitrary DHT peers.
* **Logarithmic Scalability**: $O(\log N)$ lookup performance ensures low routing overhead as network size expands.
* **Privacy & NAT Traversal**: Storing proxy/tunnel entry points directly in the DHT enables anonymous circuit creation and seamless communication across NAT barriers.

### Negative & Trade-offs
* **Lookup Latency**: Multi-hop iterative lookups introduce initial round-trip latency when connecting to previously unknown peers.
* **Maintenance Overhead**: Nodes must periodically re-store active records (due to TTL expiration) and ping stale $K$-bucket contacts.
* **Sybil Attack Vulnerability**: Malicious actors could generate numerous key pairs to cluster around specific target keys unless IP diversity checks, rate limits, and cryptographic verification rules are enforced.

---

## References
* **Specification**: [`docs/specification/networking-dht.md`](../specification/networking-dht.md)
* **ADNL Specification**: [`docs/specification/networking-adnl.md`](../specification/networking-adnl.md)
* **TON Technical Whitepaper**: §3.2 (Distributed Hash Table)
