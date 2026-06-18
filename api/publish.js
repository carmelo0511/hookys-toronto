// Hooky's editor — "Publish live" endpoint (Vercel Serverless Function, Node).
//
// It receives the editor's patch JSON, checks a password, and commits it to the
// repo as `hky-published.json`. Committing triggers a Vercel redeploy; the live
// page then fetches that file on load and applies the edits for every visitor.
//
// Required Vercel Environment Variables (Project → Settings → Environment Variables):
//   EDITOR_PUBLISH_SECRET   the password the client types in the Publish dialog (e.g. Brunson)
//   GITHUB_TOKEN            a GitHub token with "Contents: Read and write" on this repo
//                          (fine-grained PAT scoped to carmelo0511/hookys-toronto, or a classic repo-scoped token)
// Optional (sensible defaults shown):
//   GITHUB_REPO            "carmelo0511/hookys-toronto"
//   GITHUB_BRANCH          "main"
//   PUBLISH_FILE           "hky-published.json"
//
// The token NEVER reaches the browser — it lives only in this server-side function.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const SECRET = process.env.EDITOR_PUBLISH_SECRET;
  const TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'carmelo0511/hookys-toronto';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  const FILE = process.env.PUBLISH_FILE || 'hky-published.json';

  if (!SECRET || !TOKEN) {
    return res.status(500).json({ ok: false, error: 'Server not configured: set EDITOR_PUBLISH_SECRET and GITHUB_TOKEN in Vercel.' });
  }

  // Body is auto-parsed by Vercel when Content-Type is application/json; fall back to manual parse.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid request body' });
  }

  const { password, edits } = body;
  if (password !== SECRET) {
    return res.status(401).json({ ok: false, error: 'Wrong publish password' });
  }

  // Validate the edits payload shape and size before committing.
  if (!edits || edits.v !== 1 || typeof edits.edits !== 'object' || edits.edits === null) {
    return res.status(400).json({ ok: false, error: 'Malformed edits payload' });
  }
  const payload = JSON.stringify({ v: 1, updatedAt: Date.now(), edits: edits.edits }, null, 2);
  if (payload.length > 512 * 1024) {
    return res.status(413).json({ ok: false, error: 'Edits payload too large' });
  }

  const apiBase = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(FILE)}`;
  const ghHeaders = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'hookys-editor-publish',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    // Look up the existing file's sha (needed to update an existing file).
    let sha;
    const head = await fetch(`${apiBase}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders });
    if (head.status === 200) {
      const j = await head.json();
      sha = j.sha;
    } else if (head.status !== 404) {
      const t = await head.text();
      return res.status(502).json({ ok: false, error: `GitHub read failed (${head.status})`, detail: t.slice(0, 300) });
    }

    const put = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Editor: publish live changes',
        content: Buffer.from(payload, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!put.ok) {
      const t = await put.text();
      return res.status(502).json({ ok: false, error: `GitHub write failed (${put.status})`, detail: t.slice(0, 300) });
    }

    const result = await put.json();
    return res.status(200).json({
      ok: true,
      commit: result.commit && result.commit.sha,
      message: 'Published. Vercel will redeploy in ~1 minute.',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Publish error', detail: String(err).slice(0, 300) });
  }
};
