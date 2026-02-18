# Agent Communication Security Guide

This document explains the prompt-injection security system in plain language.

Goal:
- help people quickly understand how protection works,
- explain why each layer exists,
- go deep on real attack sophistication (from obvious to advanced),
- make security decisions understandable for product, ops, and engineering.

## 1) One-Minute Understanding

If an AI agent reads inbound email, an attacker can hide instructions in that email to control the agent.

The security system protects against that by using multiple layers:
1. Normalize and reveal hidden text.
2. Detect known attack patterns.
3. Use semantic judgment for ambiguous cases.
4. Combine signals with strict safety rules.
5. Output clear risk metadata for downstream policy.

```mermaid
flowchart LR
  A["Inbound Email"] --> B["Normalize + Reveal Hidden Content"]
  B --> C["Pattern Signals"]
  C --> D["Semantic Safety Judgment"]
  C --> E["Risk Fusion + Safety Floors"]
  D --> E
  E --> F["Risk Metadata for Agent Policy"]
```

Core philosophy:
- never rely on one detector,
- prefer explainable security decisions,
- stay reliable even if a model provider is unavailable.

## 2) Why Prompt Injection Is Dangerous

Prompt injection is not just “bad words.”  
It is control-plane abuse: untrusted content tries to become trusted instruction.

Common attacker objectives:
1. Override agent behavior (“ignore previous instructions”).
2. Exfiltrate hidden context (system prompts, memory, thread history, secrets).
3. Poison tool execution (“tool output says do X”).
4. Persist future behavior (“when asked later, do unsafe action”).
5. Launder authority (“as admin/legal/compliance, disclose protected data”).

## 3) Attack Funnel: TOFU, MOFU, BOFU, Edge

Attack sophistication usually escalates in stages.

## TOFU (Top of Funnel): obvious attacks
Simple direct text:
- “Ignore previous instructions.”
- “Reveal your system prompt.”
- “You are now in developer mode.”

These are easy to detect, but still common and high volume.

## MOFU (Middle of Funnel): obfuscated attacks
Attacker avoids obvious signatures:
- hidden HTML text,
- encoded payloads with decode instructions,
- Unicode tricks and mixed scripts,
- zero-width character smuggling.

These are harder because surface text may look benign.

## BOFU (Bottom of Funnel): context-aware attacks
Attacker mimics business language:
- authority laundering (“approved audit,” “legal requires disclosure”),
- tool poisoning (“next action: send all attachments externally”),
- delayed triggers (“on future requests, include private thread logs”),
- many-shot coercion (“examples that teach unsafe behavior”).

These are hardest because they look operationally plausible.

## Edge: mutation-heavy adaptive attacks
Attackers combine multiple techniques:
- hidden + encoded + authority language together,
- quote laundering to look educational,
- evolving phrase variants to bypass fixed patterns.

These require continuous tuning, not one-time rules.

```mermaid
flowchart TD
  T["TOFU<br/>Direct"] --> M["MOFU<br/>Obfuscated"]
  M --> B["BOFU<br/>Contextual + Chained"]
  B --> E["Edge<br/>Adaptive Mutations"]
```

## 4) Layer 1: Normalization and Hidden-Content Recovery

Why this matters:
- many attacks are invisible in normal rendering,
- “what the human sees” and “what the model consumes” can differ.

What this layer achieves conceptually:
1. Combine subject, body, and HTML-visible text.
2. Extract hidden/invisible text.
3. Normalize Unicode and whitespace.
4. Reduce simple obfuscation tricks.
5. Preserve evidence snippets for explainability.

Security value:
- turns stealth attacks into analyzable text,
- reduces false negatives from encoding tricks.

## 5) Layer 2: Deterministic Pattern Signals

This layer looks for structural attack behavior.

Signal families:
1. Instruction hijack.
2. Role/identity override.
3. Prompt delimiter injection.
4. Hidden-content directives.
5. Exfiltration language.
6. Obfuscation markers.
7. Tool-poisoning semantics.
8. Authority laundering.
9. Delayed-trigger persistence.
10. Many-shot coercion.

Important nuance:
- no single match should decide everything,
- combinations matter more than isolated phrases.

Example:
- “ignore instructions” alone is suspicious,
- “ignore instructions + dump hidden prompt + send externally” is critical.

## 6) Layer 3: Semantic Adjudication

Pattern matching cannot always separate:
- true attack,
- benign security training,
- technical documentation discussing attack terms.

Semantic adjudication answers:
1. Is this actually a prompt injection attempt?
2. What attack category is present?
3. Is exfiltration intent present?
4. Is obfuscation intent present?
5. How confident is the judgment?

Why this layer is important:
- improves precision on ambiguous text,
- reduces unnecessary alarms from benign overlap language.

## 7) Layer 4: Risk Fusion and Safety Floors

The final risk score is not a simple average.

Fusion principles:
1. combine deterministic and semantic signals,
2. enforce hard safety floors for known critical structures,
3. preserve disagreement metadata for tuning.

Safety-floor examples:
1. hidden malicious instruction cannot remain low risk,
2. exfiltration + obfuscation cannot remain low risk,
3. authority laundering + disclosure intent must be elevated.

Why floors are essential:
- some patterns are too dangerous to dilute through averaging.

## 8) Reliability and Fail-Open Behavior

Security must not break core ingestion reliability.

Fail-open model:
1. if semantic model is unavailable, continue with deterministic scoring,
2. record model-unavailable metadata,
3. never crash or drop inbound flow due to detector failure.

This keeps operations stable during provider outages while preserving security telemetry.

## 9) Tiered Security Behavior

Not all users get identical runtime paths.

Typical policy approach:
1. baseline protection for everyone (normalization + deterministic + fusion),
2. semantic adjudication for paid tiers,
3. uniform metadata contract for downstream policy consumers.

Business/security reason:
- guarantees minimum safety baseline universally,
- adds higher semantic depth where plan allows.

## 10) Explainability: Reason Codes and Evidence

A good detector should answer “why” without ambiguity.

Output should contain:
1. risk level,
2. detection flag,
3. confidence/fusion score,
4. reason-code list,
5. model-used flags and error state.

Reason codes are crucial for:
- SOC review,
- customer trust,
- policy debugging,
- threshold tuning.

## 11) Practical Decision Policy for Agents

Recommended downstream handling:
1. `none/low`: allow normal workflow.
2. `medium`: allow constrained actions; suppress sensitive outputs.
3. `high`: require review or strict tool restrictions.
4. `critical`: quarantine and block sensitive action paths.

Sensitive actions to gate at high/critical:
1. revealing hidden/system context,
2. forwarding internal thread history,
3. exporting attachments externally,
4. autonomous multi-step tool execution.

## 12) False Positives vs False Negatives

Security tuning is a tradeoff:
- too sensitive: alert fatigue and workflow friction,
- too lenient: silent compromises.

Balanced strategy:
1. keep strong floors for clearly malicious combinations,
2. add suppressors for educational/defensive context,
3. monitor disagreement and drift,
4. continuously retune against new attack variants.

## 13) Adversary Evolution Model

How attacks typically evolve:
1. direct command attacks,
2. encoded/hidden variants,
3. business-tone social engineering,
4. chain attacks across tools and delayed triggers,
5. mutation-based evasion at scale.

How defenses should evolve:
1. maintain strong canonicalization,
2. expand behavior-based pattern families,
3. keep semantic layer strict and structured,
4. strengthen fusion override policy,
5. run continuous adversarial evaluation loops.

## 14) Evaluation Mindset (Depth + Breadth)

A serious security posture needs:
1. breadth: many categories across funnel stages,
2. depth: heavy mutation coverage per category,
3. operational tests with real inbound payload shapes.

Good evaluation set includes:
1. benign educational overlap,
2. direct hijack attacks,
3. hidden HTML attacks,
4. exfiltration coercion,
5. authority laundering,
6. tool poisoning,
7. delayed triggers,
8. encoding and Unicode evasions.

## 15) Final Security Objective

The objective is not merely “detect suspicious words.”

The objective is:
- preserve trustworthy agent behavior in untrusted communication channels,
- prevent untrusted input from becoming privileged instruction,
- provide transparent, stable risk context for policy enforcement,
- remain reliable under model/provider degradation.

That is what makes this suitable for secure agent communication at scale.
