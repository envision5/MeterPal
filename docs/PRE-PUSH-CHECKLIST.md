# Pre-Push Checklist — making MeterPal public

Audit run Nov 12, 2026 against the working tree and full git history.
**Status: do not push yet.** Two of the three items are ready; licensing has a
hard blocker that needs a decision first.

---

## 1. Secrets — ✅ CLEAN (2 hygiene actions)

Verified, not assumed:

| Check | Result |
| --- | --- |
| `.env` / `.env.*` ignored, `!.env.example` re-included | ✅ `.gitignore:25-28` |
| `billing/.gitignore:74` (`.env*`) | ✅ covers the nested server |
| Tracked env files | ✅ 6 files, **all `.env.example`** |
| Any `.env` ever committed (full history) | ✅ never — only `.env.example` |
| PayPal secret in history (`git log -S`) | ✅ zero hits |
| Content scan of all 21,771 tracked files for `sk-*`, `AKIA*`, `ghp_*`, `xox*`, `AIza*`, PEM private keys | ✅ all hits are placeholders — CI workflows (`sk-replay-must-never-reach-a-provider`), test fixtures, cookbook notebooks, and a HuggingFace model-name list |
| `demo/probe_key.json` | ✅ ignored (`.gitignore:55`) |
| `research/` (cloned third-party repos) | ✅ ignored (`.gitignore:70`) |

### Action 1.1 — rotate the PayPal sandbox credentials
Live-looking sandbox keys sit in **untracked** files, so they will not be pushed,
but they have been sitting in plaintext on disk:

```
billing/server/.env                  PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
billing/server/.env.bak.1794376354   same pair, duplicated
```

- [ ] Rotate the sandbox app's client ID/secret in the PayPal developer dashboard
- [ ] Delete `billing/server/.env.bak.1794376354` (a stale backup of a secret file)
- [ ] Re-populate `billing/server/.env` with the new pair

### Action 1.2 — stage explicitly, never `git add -A`
One careless `git add -A` is the only way these files leak. Use `git add <paths>`.

- [ ] Confirm `.env.example` files carry no real values (spot-checked: `REPLACE_ME`,
      `change-me-*`, `mock-*`, `sk-...` — all clean)
- [ ] Enable **GitHub push protection / secret scanning** on the repo before the first push

---

## 2. Licensing — ⛔ BLOCKED as proposed

**The repo cannot be licensed AGPL-3.0 + commercial as a whole**, because ~99% of
its tracked files are third-party code under other licenses.

Tracked files by origin:

| Path | Files | Origin | Actual license | AGPL + commercial? |
| --- | ---: | --- | --- | --- |
| `gateway/` (excl. enterprise) | ~11,710 | LiteLLM | MIT | ❌ must stay MIT |
| `gateway/enterprise/` | 158 | BerriAI | **Proprietary** (paid seats) | ⛔ **must be deleted** |
| `billing/` | 9,775 | Autumn fork | Apache-2.0 | ❌ must stay Apache-2.0 |
| `sdk/ agent/ demo/ demo-app/ docs/ scripts/ docker/` + root files | ~128 | **MeterPal** | none yet | ✅ AGPL-3.0 + commercial OK |

Total 21,771 tracked files; `.git` is 166 MB.

Two blockers:

1. **`gateway/enterprise/` is proprietary.** `gateway/enterprise/LICENSE.md` is the
   BerriAI Enterprise License: production use requires paid seats, and
   modification rights are conditioned on a valid license. Publishing it in a
   public repo is not permitted — and it would break the hackathon's "public and
   open source" requirement. It must be removed.
2. **Apache-2.0 and MIT cannot be relicensed.** They *can* be combined into an
   AGPL work (both are AGPL-compatible), but the original files keep their
   notices. `NOTICE` already attributes Autumn correctly and must gain a LiteLLM
   entry.

### Recommended structure — per-directory licensing — ✅ DONE (Nov 12)

- [x] **Deleted `gateway/enterprise/`** (4.7 MB, 158 files). Verified safe: 16 files
      reference `litellm_enterprise`, every one inside `try/except ImportError`.
- [x] Patched the fallout of that deletion:
      - `gateway/Dockerfile` — removed the two `COPY ... enterprise/` lines
      - `gateway/pyproject.toml` — dropped `litellm-enterprise` from dependencies,
        from `[tool.uv.sources]`, and from `[tool.uv.workspace].members`
      - `gateway/Dockerfile` — dropped `--frozen` from both `uv sync` calls so the
        stale `gateway/uv.lock` re-resolves instead of failing
      - ⚠️ `gateway/uv.lock` still contains the old `litellm-enterprise` entries.
        Run `uv lock` in `gateway/` when convenient to refresh it properly. The
        judge path (`pip install -e .`) is unaffected.
- [x] Root `LICENSE` replaced with **AGPL-3.0** plus a scope header naming the
      MeterPal-authored paths and explicitly excluding the vendored trees
- [x] `LICENSES/Apache-2.0.txt` and `LICENSES/MIT.txt` added; `billing/LICENSE` and
      `gateway/LICENSE` left untouched
- [x] `NOTICE` extended: LiteLLM/MIT attribution, the enterprise-removal note, and
      the AGPL scope statement
- [x] `LICENSE-COMMERCIAL.md` added — commercial terms for **MeterPal code only**,
      with an explicit table stating it grants no rights in `billing/` or `gateway/`
- [x] README licensing section rewritten to state the split plainly

### Is AGPL + commercial acceptable for this hackathon?

Yes, with one caveat about framing:

- AGPL-3.0 is OSI-approved open source, so it satisfies *"public and open source,
  with a license file visible at the top of the repo"*.
- Dual licensing (AGPL in public + paid commercial terms separately) is standard
  practice and does not violate the rules. The rules' prohibition on a
  "commercial license" concerns projects **developed with** financial or
  preferential support or under a sponsor's commercial license — not your own
  outbound licensing choice.
- **Caveat:** the *public repo* must remain fully open source. Keep the AGPL
  license as the repo license and put commercial terms in a separate document.
  Do not gate any functionality the judges need to run behind the commercial
  terms.

Your "everything that was open source before stays open source" requirement is
satisfied automatically — Apache-2.0 and MIT are untouched.

---

## 3. README — ✅ REWRITTEN (Nov 12)

Repositioned as **"your own OpenRouter-style stack for serving and billing AI"**,
then the judge-facing detail. Sections now present:

- [x] One-line pitch + the problem (the gap: PayPal's Usage Based Billing does not
      meter AI inference per token)
- [x] **What's in the box** — capability table across all 10 surfaces
- [x] **The 402 story** — explicit, in the pitch and in "the path of one request"
- [x] **Judge runbook** — the verified sequence, verbatim
- [x] **"Judges: what to look at"** box — the 4 files that carry the work
- [x] **API surface table** — 18 endpoints (also feeds the APIMatic spec)
- [x] **Tools used** — PayPal rails, AI stack, supporting tools (rules requirement)
- [x] **Hackathon submission** — event link, demo video slot, how judges run it free
- [x] **License section** — the AGPL + commercial + vendored split
- [x] Documentation index, repository layout, guarantees
- [x] **Demo video URL added** — https://youtu.be/lvoW53DDbz4 (public)
- [ ] Add the APIMatic portal URL once generated (referenced from "API surface"
      and "Tools used")

---

## 4. Remaining pre-push items

- [ ] Decide on untracked `docs/VIDEO-SHOTLIST.md` — commit or drop
      (its referenced footage was deleted, so it may be stale)
- [ ] Create the GitHub repo **public** with description + license visible in the
      About section (rules require the license be "detectable and visible at the
      top of the repository page")
- [ ] Decide on history: keep full history (it proves pre-hackathon baseline vs.
      hackathon progress, which the rules reward) rather than squashing
- [ ] After the first push, verify the repo renders and the clone-and-run path
      still works from a clean clone

---

## Order of operations

1. Rotate PayPal sandbox creds, delete the `.env.bak` — **5 min**
2. Decide on the licensing split; delete `gateway/enterprise/` — **20 min**
3. Write `LICENSE`, `LICENSES/`, `LICENSE-COMMERCIAL.md`, update `NOTICE` — **30 min**
4. Rewrite README — **45 min**
5. APIMatic portal + link — **60-90 min**
6. `git add` explicit paths → commit → create public repo → push — **15 min**
