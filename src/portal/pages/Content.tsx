// Website content (CMS blocks + publishing + deploy hook) and the blog editor.
import { useMemo, useState } from 'preact/hooks'
import { renderMarkdown, slugify } from '../../lib/markdown'
import { SUPABASE_URL } from '../../lib/supabase-config.js'
import { ago, callFn, check, d, dt, mediaUrl, qs, safeName, sb, upload } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'
import { AiAssistButton } from './AI'

const BUILD_MSG: Record<string, string> = {
  triggered: 'Your website is rebuilding — changes appear in a minute or two.',
  not_configured: 'Saved. Tomorrow Web hasn’t connected automatic publishing for this site yet, so we’ll update it for you.',
  rate_limited: 'Saved. A rebuild started less than a minute ago — publish again in a minute to include these changes.',
}
export const buildMessage = (b: string) => BUILD_MSG[b] ?? `Saved, but the rebuild failed: ${b}. Tomorrow Web has been notified in the audit log.`

/** Site picker shared by content and blog pages. */
function useSites(bizId: string) {
  const sites = useLoad(async () => check(await sb().from('sites').select('id, name, url, public_key, build_hook_secret_id, last_build_at, last_build_status, content_published_at').eq('business_id', bizId).order('created_at')) as any[], [bizId])
  const [siteId, setSiteId] = useState<string | null>(null)
  const site = sites.data?.find((s) => s.id === siteId) ?? sites.data?.[0] ?? null
  return { sites, site, setSiteId }
}

function SitePicker({ sites, site, setSiteId }: ReturnType<typeof useSites>) {
  if ((sites.data?.length ?? 0) < 2) return null
  return (
    <label class="p-field" style={{ maxWidth: '320px', marginBottom: '1rem' }}>
      <span>Website</span>
      <select value={site?.id} onChange={(e) => setSiteId((e.target as HTMLSelectElement).value)}>
        {sites.data!.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}

// ── Website content ───────────────────────────────────────────────────────
export function Content() {
  return (
    <Portal title="Website content" need="business" module="cms" perm="settings.manage">
      {(app) => <ContentBody app={app} />}
    </Portal>
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function ContentBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const picker = useSites(bizId)
  const site = picker.site
  const { busy, run } = useAction()
  const [adding, setAdding] = useState(false)
  const blocks = useLoad(async () => (site ? (check(await sb().from('content_blocks').select('*').eq('site_id', site.id).order('sort').order('key')) as any[]) : []), [site?.id])
  const pending = (blocks.data ?? []).filter((b) => !same(b.draft, b.published)).length

  if (picker.sites.loading) return <div class="p-loading">Loading…</div>
  if (!site) return <><PageHead title="Website content" /><Empty>No website is linked to this business yet. Tomorrow Web will link it when your site is set up.</Empty></>

  return (
    <>
      <PageHead title="Website content" sub={<>Edit the text and images marked as editable on <strong>{site.name}</strong>. Changes stay as drafts until you publish.</>}>
        <button class="btn btn-ink p-btn" disabled={busy || !pending} onClick={() => run(async () => {
          const r = await callFn('site-publish', { site_id: site.id, scope: 'content' })
          await blocks.reload(); await picker.sites.reload()
          app.toast(buildMessage(r.build), r.build.startsWith('failed') ? 'bad' : 'ok')
        })}>{pending ? `Publish ${pending} change${pending > 1 ? 's' : ''}` : 'Everything published'}</button>
      </PageHead>
      <SitePicker {...picker} />
      <ErrorNote error={blocks.error} />
      {site.content_published_at && <p class="p-small p-muted">Last published {dt(site.content_published_at)}.</p>}

      {blocks.data?.length ? (
        <div class="p-stack">
          {blocks.data.map((b) => <BlockEditor key={b.id} block={b} bizId={bizId} isAdmin={app.isAdmin} onSaved={blocks.reload} />)}
        </div>
      ) : !blocks.loading && <Empty>No editable content has been set up for this site yet.{app.isAdmin && ' Add blocks below.'}</Empty>}

      {app.isAdmin && (
        <div class="p-row" style={{ marginTop: '1rem' }}>
          <button class="btn btn-ghost p-btn" onClick={() => setAdding(true)}>Add content block</button>
        </div>
      )}
      <PublishingCard site={site} onSaved={picker.sites.reload} />
      {adding && <AddBlock siteId={site.id} onClose={() => setAdding(false)} onDone={() => { setAdding(false); blocks.reload() }} />}
    </>
  )
}

function BlockEditor({ block, bizId, isAdmin, onSaved }: { block: any; bizId: string; isAdmin: boolean; onSaved: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const [draft, setDraft] = useState<any>(block.draft ?? {})
  const dirty = !same(draft, block.draft)
  const unpublished = !same(block.draft, block.published)
  const save = () => run(async () => { check(await sb().from('content_blocks').update({ draft }).eq('id', block.id)); await onSaved() }, 'Draft saved')
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v })
  return (
    <div class="p-card">
      <div class="p-row">
        <strong>{block.label}</strong>
        {unpublished && <Badge tone="warn">not published</Badge>}
        <span class="p-spacer" />
        {isAdmin && <code class="p-small p-muted">{block.key}</code>}
      </div>
      {block.help && <p class="p-small p-muted" style={{ margin: '0.25rem 0 0.5rem' }}>{block.help}</p>}
      {block.kind === 'text' && (
        (block.max_length ?? 200) > 120
          ? <textarea rows={3} maxLength={block.max_length ?? undefined} value={draft.text ?? ''} onInput={(e) => set('text', (e.target as HTMLTextAreaElement).value)} aria-label={block.label} />
          : <input maxLength={block.max_length ?? undefined} value={draft.text ?? ''} onInput={(e) => set('text', (e.target as HTMLInputElement).value)} aria-label={block.label} />
      )}
      {block.kind === 'richtext' && <MarkdownField value={draft.md ?? ''} onChange={(v) => set('md', v)} max={block.max_length} label={block.label} />}
      {block.kind === 'link' && (
        <div class="row2">
          <Field label="Button / link text"><input value={draft.label ?? ''} maxLength={80} onInput={(e) => set('label', (e.target as HTMLInputElement).value)} /></Field>
          <Field label="Goes to"><input value={draft.href ?? ''} placeholder="https:// or /page/" onInput={(e) => set('href', (e.target as HTMLInputElement).value)} /></Field>
        </div>
      )}
      {block.kind === 'image' && (
        <div class="p-row" style={{ alignItems: 'flex-start' }}>
          {draft.path && <img src={mediaUrl(draft.path)} alt="" style={{ width: '160px', height: '110px', objectFit: 'cover', borderRadius: '10px' }} />}
          <div class="p-stack" style={{ flex: 1 }}>
            <label class="btn btn-ghost p-btn" style={{ cursor: 'pointer', width: 'fit-content' }}>
              {busy ? 'Uploading…' : draft.path ? 'Replace image' : 'Upload image'}
              <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/avif,image/gif" onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) run(async () => {
                  if (file.size > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB. Try a smaller or compressed image.')
                  const path = await upload('media', `${bizId}/content/${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`, file)
                  setDraft({ ...draft, path })
                }, 'Uploaded — remember to save')
              }} />
            </label>
            <Field label="Describe the image (for screen readers and Google)"><input value={draft.alt ?? ''} maxLength={200} onInput={(e) => set('alt', (e.target as HTMLInputElement).value)} /></Field>
          </div>
        </div>
      )}
      <div class="p-row" style={{ marginTop: '0.6rem' }}>
        {block.updated_at && <span class="p-small p-muted">Edited {ago(block.updated_at)}</span>}
        <span class="p-spacer" />
        {isAdmin && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm(`Delete the “${block.label}” block?`) && run(async () => { check(await sb().from('content_blocks').delete().eq('id', block.id)); await onSaved() }, 'Block deleted')}>Delete</button>}
        <button class="btn btn-ink p-btn" disabled={busy || !dirty} onClick={save}>Save draft</button>
      </div>
    </div>
  )
}

export function MarkdownField({ value, onChange, max, label, rows = 8 }: { value: string; onChange: (v: string) => void; max?: number | null; label: string; rows?: number }) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const html = useMemo(() => (tab === 'preview' ? renderMarkdown(value) : ''), [tab, value])
  return (
    <div>
      <div class="p-tabs" role="tablist" style={{ marginBottom: '0.5rem' }}>
        <button type="button" role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>Write</button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
      </div>
      {tab === 'write'
        ? <textarea rows={rows} maxLength={max ?? undefined} value={value} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} aria-label={label} style={{ fontFamily: 'var(--f-mono)', fontSize: '0.9rem' }} />
        : <div class="p-prose" dangerouslySetInnerHTML={{ __html: html || '<p class="p-muted">Nothing to preview.</p>' }} />}
      <p class="p-small p-muted" style={{ margin: '0.3rem 0 0' }}>Formatting: ## Heading, **bold**, *italic*, - list, [link](https://…){max ? ` · ${value.length}/${max}` : ''}</p>
    </div>
  )
}

function AddBlock({ siteId, onClose, onDone }: { siteId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction()
  return (
    <Modal title="Add content block" onClose={onClose}>
      <form class="p-form" onSubmit={(e) => {
        const f = formData(e)
        run(async () => {
          check(await sb().from('content_blocks').insert({
            site_id: siteId, key: f.key.trim(), label: f.label.trim(), kind: f.kind, help: f.help.trim() || null,
            max_length: f.max_length ? Number(f.max_length) : null, sort: Number(f.sort || 100), draft: {},
          }))
          onDone()
        }, 'Block added')
      }}>
        <div class="row2">
          <Field label="Key (used in the site’s code)" hint="e.g. hero.title — lowercase, dots/dashes"><input name="key" required pattern="[a-z0-9][a-z0-9_.\-]{0,63}" /></Field>
          <Field label="Label (what the client sees)"><input name="label" required maxLength={120} /></Field>
        </div>
        <div class="row2">
          <Field label="Type"><select name="kind"><option value="text">Text</option><option value="richtext">Rich text (Markdown)</option><option value="image">Image</option><option value="link">Link / button</option></select></Field>
          <Field label="Max length"><input name="max_length" type="number" min="1" max="20000" /></Field>
        </div>
        <div class="row2">
          <Field label="Help text"><input name="help" maxLength={300} /></Field>
          <Field label="Order"><input name="sort" type="number" defaultValue="100" /></Field>
        </div>
        <button class="btn btn-ink p-btn" disabled={busy}>Add</button>
      </form>
    </Modal>
  )
}

function PublishingCard({ site, onSaved }: { site: any; onSaved: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const [show, setShow] = useState(false)
  return (
    <div class="p-card" style={{ marginTop: '1.5rem' }}>
      <h2>Automatic publishing</h2>
      <p class="p-small">
        {site.build_hook_secret_id
          ? <>Connected. Publishing rebuilds the site automatically.{site.last_build_at && <> Last rebuild {ago(site.last_build_at)}: {site.last_build_status}.</>}</>
          : <>Not connected. Published changes are saved, and Tomorrow Web updates the live site for you.</>}
      </p>
      {!show ? (
        <button class="btn btn-ghost p-btn" onClick={() => setShow(true)}>{site.build_hook_secret_id ? 'Change deploy hook' : 'Connect a deploy hook'}</button>
      ) : (
        <form class="p-form" onSubmit={(e) => {
          const f = formData(e)
          run(async () => { check(await sb().rpc('set_site_build_hook', { p_site: site.id, p_url: f.url.trim() })); setShow(false); await onSaved() }, f.url.trim() ? 'Deploy hook saved securely' : 'Deploy hook removed')
        }}>
          <Field label="Deploy hook URL" hint="Netlify: Site configuration → Build & deploy → Build hooks. Stored encrypted in Supabase Vault and never shown again. Leave empty to disconnect.">
            <input name="url" type="url" autoComplete="off" placeholder="https://api.netlify.com/build_hooks/…" />
          </Field>
          <div class="p-row"><button class="btn btn-ink p-btn" disabled={busy}>Save</button><button type="button" class="btn btn-ghost p-btn" onClick={() => setShow(false)}>Cancel</button></div>
        </form>
      )}
      <details style={{ marginTop: '0.75rem' }}>
        <summary class="p-small">For developers</summary>
        <p class="p-small p-muted">Site key: <code>{site.public_key}</code>. Published content: <code>{`${SUPABASE_URL}/rest/v1/rpc/site_content`}</code> with <code>{'{"p_key": "…"}'}</code> — or copy <code>kit/cms.ts</code> into the site.</p>
      </details>
    </div>
  )
}

// ── Blog ──────────────────────────────────────────────────────────────────
export function Blog() {
  return (
    <Portal title="Blog" need="business" module="blog" perm="settings.manage">
      {(app) => <BlogBody app={app} />}
    </Portal>
  )
}

function BlogBody({ app }: { app: ReturnType<typeof useApp> }) {
  const picker = useSites(app.bizId!)
  const site = picker.site
  const posts = useLoad(async () => (site ? (check(await sb().from('posts').select('id, slug, title, status, published_at, updated_at, ai_assisted').eq('site_id', site.id).order('updated_at', { ascending: false })) as any[]) : []), [site?.id])
  if (picker.sites.loading) return <div class="p-loading">Loading…</div>
  if (!site) return <><PageHead title="Blog" /><Empty>No website is linked to this business yet.</Empty></>
  return (
    <>
      <PageHead title="Blog" sub={`Posts for ${site.name}.`}>
        <a class="btn btn-ink p-btn" href={`/portal/blog/edit/?site=${site.id}`}>New post</a>
      </PageHead>
      <SitePicker {...picker} />
      <ErrorNote error={posts.error} />
      {posts.data?.length ? (
        <div class="p-table-wrap">
          <table class="p-table">
            <thead><tr><th>Title</th><th>Status</th><th>Published</th><th>Updated</th></tr></thead>
            <tbody>
              {posts.data.map((p) => (
                <tr key={p.id}>
                  <td><a href={`/portal/blog/edit/?id=${p.id}`}>{p.title}</a> {p.ai_assisted && <Badge tone="ai">AI-assisted</Badge>}<div class="p-small p-muted">/{p.slug}/</div></td>
                  <td>{p.status === 'published' ? <Badge tone="ok">Published</Badge> : <Badge>Draft</Badge>}</td>
                  <td>{d(p.published_at)}</td>
                  <td>{ago(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !posts.loading && <Empty>No posts yet. Write your first one with “New post”.</Empty>}
    </>
  )
}

export function BlogEdit() {
  return (
    <Portal title="Edit post" need="business" module="blog" perm="settings.manage">
      {(app) => <BlogEditBody app={app} id={qs('id')} siteParam={qs('site')} />}
    </Portal>
  )
}

function BlogEditBody({ app, id, siteParam }: { app: ReturnType<typeof useApp>; id: string | null; siteParam: string | null }) {
  const { busy, run } = useAction()
  const loaded = useLoad(async () => (id ? (check(await sb().from('posts').select('*').eq('id', id).maybeSingle()) as any) : null), [id])
  if (loaded.loading) return <div class="p-loading">Loading…</div>
  if (loaded.error) return <ErrorNote error={loaded.error} />
  if (id && !loaded.data) return <ErrorNote error="This post doesn’t exist or you can’t edit it." />
  return <PostForm app={app} post={loaded.data} siteId={loaded.data?.site_id ?? siteParam} busy={busy} run={run} />
}

function PostForm({ app, post, siteId, busy, run }: { app: ReturnType<typeof useApp>; post: any; siteId: string | null; busy: boolean; run: ReturnType<typeof useAction>['run'] }) {
  const bizId = app.bizId!
  const [p, setP] = useState<any>(post ?? { title: '', slug: '', excerpt: '', body_md: '', tags: [], cover_path: null, cover_alt: '', seo_title: '', seo_description: '', status: 'draft' })
  const [slugTouched, setSlugTouched] = useState(!!post)
  const set = (k: string, v: unknown) => setP((x: any) => ({ ...x, [k]: v }))
  if (!siteId) return <ErrorNote error="Choose a website first." />

  async function save(status?: 'draft' | 'published') {
    const row = {
      site_id: siteId, title: p.title.trim(), slug: p.slug || slugify(p.title), excerpt: p.excerpt?.trim() || null, body_md: p.body_md ?? '',
      tags: (Array.isArray(p.tags) ? p.tags : String(p.tags).split(',')).map((t: string) => t.trim()).filter(Boolean).slice(0, 12),
      cover_path: p.cover_path || null, cover_alt: p.cover_alt?.trim() || null, seo_title: p.seo_title?.trim() || null,
      seo_description: p.seo_description?.trim() || null, status: status ?? p.status, ai_assisted: !!p.ai_assisted,
    }
    if (!row.title) throw new Error('Give the post a title.')
    if (!row.slug) throw new Error('Add a web address (slug).')
    const saved = p.id
      ? (check(await sb().from('posts').update(row).eq('id', p.id).select('*').single()) as any)
      : (check(await sb().from('posts').insert(row).select('*').single()) as any)
    setP(saved)
    if (!p.id) history.replaceState(null, '', `/portal/blog/edit/?id=${saved.id}`)
    if (status && status !== p.status || (saved.status === 'published')) {
      const r = await callFn('site-publish', { site_id: siteId, scope: 'build' })
      app.toast(buildMessage(r.build), r.build.startsWith('failed') ? 'bad' : 'ok')
    }
    return saved
  }

  return (
    <>
      <PageHead title={p.id ? 'Edit post' : 'New post'} sub={p.status === 'published' ? <Badge tone="ok">Published {d(p.published_at)}</Badge> : <Badge>Draft</Badge>}>
        <a class="btn btn-ghost p-btn" href="/portal/blog/">All posts</a>
      </PageHead>
      <div class="p-grid-editor">
        <div class="p-card p-form">
          <Field label="Title"><input value={p.title} maxLength={160} required onInput={(e) => { const v = (e.target as HTMLInputElement).value; set('title', v); if (!slugTouched) set('slug', slugify(v)) }} /></Field>
          <Field label="Web address" hint="Lowercase words joined by dashes.">
            <input value={p.slug} maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" onInput={(e) => { setSlugTouched(true); set('slug', slugify((e.target as HTMLInputElement).value)) }} />
          </Field>
          <Field label="Short summary" hint="Shown in the blog list and Google results. Up to 300 characters."><textarea rows={2} maxLength={300} value={p.excerpt ?? ''} onInput={(e) => set('excerpt', (e.target as HTMLTextAreaElement).value)} /></Field>
          <div class="p-row">
            <AiAssistButton label="Draft with AI" task="blog_draft" siteId={siteId} disabled={!p.title}
              input={() => `Business: ${app.biz?.business_name}\nPost title: ${p.title}\nSummary/notes: ${p.excerpt ?? ''}\n${p.body_md ? `\nExisting notes:\n${p.body_md}` : ''}`}
              onResult={(text) => { set('body_md', text); set('ai_assisted', true) }} />
            <AiAssistButton label="Polish wording" task="blog_polish" siteId={siteId} disabled={!p.body_md}
              input={() => p.body_md} onResult={(text) => { set('body_md', text); set('ai_assisted', true) }} />
            {p.ai_assisted && <Badge tone="ai">AI-assisted — review before publishing</Badge>}
          </div>
          <MarkdownField label="Post" rows={18} max={100000} value={p.body_md ?? ''} onChange={(v) => set('body_md', v)} />
        </div>
        <div class="p-stack">
          <div class="p-card p-form">
            <div class="p-row">
              <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(() => save(), 'Saved')}>Save</button>
              {p.status === 'published'
                ? <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(() => save('draft'), 'Unpublished')}>Unpublish</button>
                : <button class="btn btn-ink p-btn" disabled={busy} onClick={() => run(() => save('published'), 'Published')}>Publish</button>}
            </div>
            {p.id && (
              <button class="btn btn-ghost p-btn p-btn-danger" disabled={busy} onClick={() => confirm('Delete this post permanently?') && run(async () => {
                check(await sb().from('posts').delete().eq('id', p.id))
                if (p.status === 'published') await callFn('site-publish', { site_id: siteId, scope: 'build' })
                location.href = '/portal/blog/'
              }, 'Deleted')}>Delete post</button>
            )}
          </div>
          <div class="p-card p-form">
            <h3>Cover image</h3>
            {p.cover_path && <img src={mediaUrl(p.cover_path)} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '10px' }} />}
            <label class="btn btn-ghost p-btn" style={{ cursor: 'pointer', width: 'fit-content' }}>
              {p.cover_path ? 'Replace' : 'Upload'}
              <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/avif" onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) run(async () => {
                  if (file.size > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB.')
                  set('cover_path', await upload('media', `${bizId}/blog/${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`, file))
                }, 'Uploaded — remember to save')
              }} />
            </label>
            {p.cover_path && <button class="p-link p-small" onClick={() => set('cover_path', null)}>Remove cover</button>}
            <Field label="Describe the image"><input value={p.cover_alt ?? ''} maxLength={200} onInput={(e) => set('cover_alt', (e.target as HTMLInputElement).value)} /></Field>
          </div>
          <div class="p-card p-form">
            <h3>Search & tags</h3>
            <Field label="Tags" hint="Comma separated"><input value={Array.isArray(p.tags) ? p.tags.join(', ') : p.tags} onInput={(e) => set('tags', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Google title (optional)" hint={`${(p.seo_title ?? '').length}/70`}><input value={p.seo_title ?? ''} maxLength={70} onInput={(e) => set('seo_title', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Google description (optional)" hint={`${(p.seo_description ?? '').length}/170`}><textarea rows={3} maxLength={170} value={p.seo_description ?? ''} onInput={(e) => set('seo_description', (e.target as HTMLTextAreaElement).value)} /></Field>
          </div>
        </div>
      </div>
    </>
  )
}
