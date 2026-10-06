---
title: Trie
description: A tree keyed by characters, so every string sharing a prefix shares a path and prefix lookups cost the prefix length
area: distributed-data
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization]
status: stable
aliases: [prefix tree, digital tree]
solves: [Typeahead is too slow when every keystroke is matched against millions of stored phrases, Looking up every key that starts with some text scans the whole table, "Storing millions of similar strings, such as URLs or words, wastes memory on repeated beginnings", Spell check or autocomplete must list all words sharing the first few letters]
---

# Trie

A prefix tree: each edge is one character and each path from the root spells a stored string, so finding everything that starts with a prefix means walking to one node and reading below it.

## What it is
<!--meta block=description-->

Autocomplete over a sorted list of 10 million phrases needs a binary search for each keystroke, and still has to read every match under the prefix. A trie stores the phrases as paths of characters, so all strings with the same prefix share the same first nodes. A lookup walks one node per typed character, then collects or ranks the strings below. Typeahead, spell suggestions and longest-prefix route matching all depend on that shape.

## Explained
<!--meta block=explain-->

A trie stores strings as paths of characters, one edge per character, so every string that starts the same way shares the same first nodes. To find completions you walk one node per typed character, which costs the prefix length and not the size of the data, then read what sits below that node. Choose it over a sorted list with binary search when you answer a query on every keystroke. Both must read every match under the prefix unless each node caches its top completions, and the trie makes that cache a one-node read. Choose a hash map when you only ever look up whole keys. To keep suggestions fast, store the few best completions at each node and rebuild them offline from query counts.

- **Memory.** One node per character costs far more than the text, so merge single-child chains into one string-labelled edge (a radix trie).
- **Stale ranks.** Counts shift between rebuilds, so a new query surfaces only after the next swap.
- **Prefix only.** It cannot find a word in the middle of a string, so pair it with an inverted index.

**Example.** A search box suggests queries from 10 million past phrases averaging 20 characters. A sorted list needs about 23 comparisons to find the prefix "ca", then reads every phrase under it, perhaps 400,000, to rank them. A trie walks 2 nodes and reads the 5 suggestions cached on the second one, so the lookup is 2 node reads plus one cached list, with no scan of the 400,000 matches. The price is memory: at most 200 million nodes (no shared prefixes) at an assumed 30 bytes each is about 6 GB, before prefix sharing and radix compression shrink it. A nightly job rebuilds counts and swaps the new trie in.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a typed prefix become a ranked list of suggestions? The query walks one edge per character to a node, and that node already holds its top completions."
flowchart LR
    U["Client: types 'ca'"]
    subgraph T["Trie service"]
        Root(("root"))
        C(("c"))
        A(("ca"))
        Top[("Top 5 completions cached at the node")]
    end
    Build["Offline job: query counts"]:::ext
    U -->|"1 prefix"| Root
    Root -->|"2 edge c"| C
    C -->|"3 edge a"| A
    A -->|"4 read the node's list"| Top
    Top -->|"5 suggestions"| U
    Build -->|"6 rebuild and swap"| T
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Two writes then a prefix query. Insert follows or creates one node per character; the query stops at the prefix node and reads below it."
sequenceDiagram
    participant C as Caller
    participant T as Trie
    C->>T: insert "car"
    T->>T: create c, a, r and mark r as a word end
    C->>T: insert "cat"
    T->>T: reuse c and a, create t
    C->>T: startsWith "ca"
    T->>T: walk c then a
    T-->>C: collect words below: car, cat
```

## Variations
<!--meta block=variations-->

- **Radix (compressed) trie** — A chain of single-child nodes collapses into one edge labelled with a string. It cuts node count sharply on sparse sets such as URLs or words.
- **Top-k cached per node** — Each node stores the few best completions for its prefix, so a query reads one node instead of walking the subtree. Ranks go stale until the next rebuild.
- **Longest-prefix match** — A lookup remembers the deepest node that marks a stored entry and returns it. IP routing tables work this way, with bits instead of characters.
- **Bitwise or level-compressed trie** — Keys are bit strings and several levels merge into one array-indexed node, which keeps routing lookups to a few memory reads.
- **Sharded by prefix** — Split the trie across servers by the first one or two characters. Hot prefixes such as "a" or "s" can still overload one shard, so replicate them.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Lookup cost is the prefix length** — it does not depend on how many strings are stored, so reaching the prefix node takes the same walk at any entry count; reading completions stays constant only with top-k cached per node.
- **Prefix queries are one walk** — everything under the prefix sits below one node, with no scan and no sort. Without cached top-k, ranking still reads the subtree; caching top-k per node removes that.
- **Shared prefixes share storage** — many phrases that start alike store their common start once.
- **Longest-prefix match is natural** — you keep the last matching node while walking, which is what routing and URL matching need.

### Cons
<!--meta polarity=con-->

- **Memory per node is large** — a pointer per child dwarfs one byte of text, so merge chains into radix edges and compare resident memory on a sample of your real keys.
- **Rankings go stale** — cached top-k lists change only on rebuild, so rebuild from counts on a schedule, swap the copy atomically, set the interval by how fast new queries must show up, and alert on rebuild age.
- **Only prefixes match** — "phone case" will not be found by typing "case". Pair it with an [inverted index](inverted-index.md) for word-level search.
- **Typos break the walk** — one wrong early character leads to the wrong subtree, so add fuzzy matching or a spell-corrector in front.
- **Updates under load are awkward** — locking nodes slows readers, so prefer a read-only trie rebuilt offline over live mutation.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You suggest completions as the user types**, and each keystroke must answer in a few milliseconds.
- **You match the longest stored prefix**, such as a route, an IP range or a URL path.
- **Many strings share long prefixes**, and a sorted list or hash map would repeat or miss them.

### Avoid when
<!--meta polarity=avoid-->

- **You match words anywhere in the text**; an [inverted index](inverted-index.md) is the right structure.
- **The set is small**, a few thousand strings, where a sorted array and binary search is simpler.
- **Memory is tight and keys are long and unrelated**, so there is little prefix sharing to exploit.
- **Rankings must update within seconds**, or memory stays over budget after radix compression; an inverted index is the better fit.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal trie with insert and top-k autocomplete, counts decide the ranking"
class Node { children = new Map<string, Node>(); count = 0 } // count > 0 ends a stored word
class Trie {
  private root = new Node();
  insert(word: string, count = 1) {
    let node = this.root;
    for (const ch of word) {                  // reuse the shared prefix path
      if (!node.children.has(ch)) node.children.set(ch, new Node());
      node = node.children.get(ch)!;
    }
    node.count += count;
  }
  suggest(prefix: string, k = 3): string[] {
    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return [];                   // no stored word starts this way
      node = next;
    }
    const found: [string, number][] = [];
    const walk = (n: Node, acc: string) => {
      if (n.count > 0) found.push([acc, n.count]);
      for (const [ch, child] of n.children) walk(child, acc + ch);
    };
    walk(node, prefix);                       // fine for a sketch; cache top-k per node in production
    return found.sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w);
  }
}
// insert("car", 50), ("cat", 80), ("cart", 20) → suggest("ca") is ["cat", "car", "cart"]
```

## In the wild
<!--meta block=wild-->

- **Linux kernel routing table** — The IPv4 forwarding table is stored as a level-compressed trie (LC-trie, in fib_trie.c), so a route lookup finds the longest matching prefix of the destination address. {#wild-linux-fib-trie}
- **Redis radix tree** — Redis ships a radix tree implementation (rax) and uses it to store streams, whose entry IDs are keys in a compressed prefix tree. {#wild-redis-rax}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Proximity Search](../../../themes/proximity-search.md) — Look up everything under a prefix by walking one path of a tree. {#fluency-proximity-search}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Inverted Index](./inverted-index.md) — The inverted index answers word-level search that a prefix tree cannot
- [Top-K](../../../designs/top-k.md) — Cache the best few completions at each node, ranked by query counts from a top-k job
- [Geohash](../routing/geohash.md) — A geohash is a prefix-sortable string, so prefix search over cells is the same walk
- [API Routing](../routing/api-routing.md) — Longest-prefix matching on a path trie picks the route for a request URL

<!-- relationships:end -->
