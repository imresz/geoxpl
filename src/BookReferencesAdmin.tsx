import { useEffect,useState } from 'react';
import { ArrowUpRight,BookOpen,Check,LoaderCircle,Pencil,Plus,RefreshCw,Save,Search,Undo2,X } from 'lucide-react';
import { api,statusLabel } from './api';
import { emptyBook,type Book,type BookRecord,type BookCitation,type CitationInput,type BookPermissions } from './book-reference-types';
import './book-references.css';

type FeatureOption={id:string;name:string;displayName:string;type:string;revisionId:string;jobId:string};
type Draft={id?:string;version:number;book:Book;history?:BookRecord['history']};
type CitationDraft={id?:string;version:number;citation:CitationInput};
const permissionNames:Record<keyof BookPermissions,string>={text:'Text reproduction',images:'Photographs and illustrations',mapDigitisation:'Map reproduction / digitisation',aiProcessing:'Digital copying for AI processing'};
const cleanLines=(values:string[])=>values.map(s=>s.trim()).filter(Boolean);
const stamp=(value:string)=>new Date(value).toLocaleString();

export function BookReferencesAdmin() {
  const [books,setBooks]=useState<BookRecord[]>([]),[features,setFeatures]=useState<FeatureOption[]>([]),[tab,setTab]=useState('books');
  const [filter,setFilter]=useState(''),[archived,setArchived]=useState(false),[draft,setDraft]=useState<Draft|null>(null),[reason,setReason]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  const [featureFilter,setFeatureFilter]=useState(''),[featureId,setFeatureId]=useState(''),[citations,setCitations]=useState<BookCitation[]>([]),[citationLoading,setCitationLoading]=useState(false);
  const [citationDraft,setCitationDraft]=useState<CitationDraft|null>(null),[citationReason,setCitationReason]=useState(''),[withdrawing,setWithdrawing]=useState<BookCitation|null>(null),[withdrawReason,setWithdrawReason]=useState('');
  const refresh=async()=>{const [b,f]=await Promise.all([api<BookRecord[]>('/admin/books'),api<FeatureOption[]>('/admin/book-reference-features')]);setBooks(b);setFeatures(f);setLoaded(true);};
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
  useEffect(()=>{
    setCitations([]);setCitationDraft(null);setWithdrawing(null);if(!featureId)return;
    const controller=new AbortController();setCitationLoading(true);
    api<BookCitation[]>(`/admin/book-citations?featureId=${encodeURIComponent(featureId)}`,'GET',undefined,controller.signal).then(rows=>{if(!controller.signal.aborted)setCitations(rows);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setCitationLoading(false);});
    return()=>controller.abort();
  },[featureId]);
  async function action(fn:()=>Promise<void>) {setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function editBook(id:string) {await action(async()=>{const b=await api<BookRecord>(`/admin/books/${id}`);setDraft(b);setReason('');});}
  function patch(p:Partial<Book>) {setDraft(d=>d?{...d,book:{...d.book,...p}}:d);}
  const rights=(p:Partial<Book['rights']>)=>draft&&patch({rights:{...draft.book.rights,...p}});
  const credibility=(p:Partial<Book['credibility']>)=>draft&&patch({credibility:{...draft.book.credibility,...p}});
  async function saveBook(event:React.FormEvent) {
    event.preventDefault();if(!draft)return;
    await action(async()=>{
      const body={version:draft.version,reason,book:{...draft.book,authors:cleanLines(draft.book.authors),credibility:{...draft.book.credibility,evidenceUrls:cleanLines(draft.book.credibility.evidenceUrls)}}};
      const saved=await api<BookRecord>(draft.id?`/admin/books/${draft.id}`:'/admin/books',draft.id?'PUT':'POST',body);
      setDraft(await api<BookRecord>(`/admin/books/${saved.id}`));setReason('');await refresh();setNotice('Book record saved. No geometry or processing permissions were changed.');
    });
  }
  const selected=features.find(f=>f.id===featureId),activeBooks=books.filter(b=>b.book.state==='active');
  function newCitation() {
    if(!selected)return;
    setCitationDraft({version:0,citation:{featureId:selected.id,revisionId:selected.revisionId,bookId:'',bookVersion:0,locator:'',relationship:'context',claim:'',limitations:'',originalWording:false,publishConfirmed:false}});
    setCitationReason('Initial reference annotation');setNotice('');
  }
  const changeCitation=(p:Partial<CitationInput>)=>setCitationDraft(d=>d?{...d,citation:{...d.citation,...p}}:d);
  const refreshCitations=async()=>setCitations(await api<BookCitation[]>(`/admin/book-citations?featureId=${encodeURIComponent(featureId)}`));
  async function publishCitation(event:React.FormEvent) {
    event.preventDefault();if(!citationDraft)return;
    await action(async()=>{
      await api(citationDraft.id?`/admin/book-citations/${citationDraft.id}`:'/admin/book-citations',citationDraft.id?'PUT':'POST',{
        version:citationDraft.version,reason:citationReason,citation:citationDraft.citation});
      setCitationDraft(null);await refreshCitations();setNotice('Reference note published for the selected geometry revision.');
    });
  }
  return <section className="book-admin" aria-label="Book references">
    <div className="section-heading"><h2>Book references</h2><button type="button" className="icon-button" aria-label="Refresh book references" title="Refresh book references" disabled={busy} onClick={()=>action(refresh)}><RefreshCw size={17}/></button></div>
    <div className="book-view-tabs" role="tablist" aria-label="Book reference views"><button role="tab" aria-selected={tab==='books'} onClick={()=>setTab('books')}>Books <span className="nav-count">{books.length}</span></button><button role="tab" aria-selected={tab==='citations'} onClick={()=>setTab('citations')}>Feature references</button></div>
    {error&&<p className="error" role="alert">{error}<button className="icon-button" title="Dismiss error" aria-label="Dismiss book reference error" onClick={()=>setError('')}><X size={15}/></button></p>}
    {notice&&<p className="book-notice" role="status"><Check size={16}/>{notice}</p>}
    {!loaded&&!error&&<p className="book-loading"><LoaderCircle className="spin" size={18}/>Loading references</p>}
    {tab==='books'?<div className="book-workspace"><aside className="book-list" aria-label="Registered books">
      <div className="book-list-tools"><label className="book-filter"><Search size={16}/><input aria-label="Filter books" placeholder="Filter books" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
        <button type="button" className="secondary small-button" disabled={busy} onClick={()=>{setDraft({version:0,book:emptyBook()});setReason('Initial book registration');setError('');setNotice('');}}><Plus size={16}/>Add book</button></div>
      <label className="book-check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>Include archived books</label>
      {books.filter(b=>(archived||b.book.state==='active')&&`${b.book.title} ${b.book.authors.join(' ')} ${b.book.isbn}`.toLowerCase().includes(filter.toLowerCase())).map(b=><button type="button" key={b.id} className={`book-list-row ${draft?.id===b.id?'selected':''}`} disabled={busy} onClick={()=>editBook(b.id)}>
        <BookOpen size={18}/><span><strong>{b.book.title}</strong><small>{b.book.authors.join('; ')}{b.book.year?` · ${b.book.year}`:''}</small><small>{b.book.state==='archived'?'Archived':b.book.rights.mode==='reference_only'?'Reference only; rights unverified':b.book.rights.mode==='restricted'?'Reuse restricted':'Permission record'} · revision {b.version}</small></span><Pencil size={14}/>
      </button>)}
      {loaded&&!books.length&&<p className="muted small">No books registered.</p>}
    </aside><div className="book-editor">
      {!draft?<p className="muted book-empty">{books.length} registered {books.length===1?'book':'books'}. No book content has been imported.</p>:<form onSubmit={saveBook} aria-label="Book record editor"><div className="book-editor-heading"><h3>{draft.id?'Edit book record':'New book'}</h3><button type="button" className="icon-button" aria-label="Close book editor" title="Close book editor" disabled={busy} onClick={()=>setDraft(null)}><X size={18}/></button></div>
        <fieldset disabled={busy}><legend>Bibliographic record</legend><div className="book-fields">
          <label className="span-two">Title<input required minLength={3} maxLength={300} value={draft.book.title} onChange={e=>patch({title:e.target.value})}/></label>
          <label className="span-two">Authors<textarea rows={2} required value={draft.book.authors.join('\n')} onChange={e=>patch({authors:e.target.value.split('\n')})}/></label>
          <label>Publisher<input maxLength={200} value={draft.book.publisher} onChange={e=>patch({publisher:e.target.value})}/></label>
          <label>Publication year<input type="number" min={1000} max={2100} value={draft.book.year??''} onChange={e=>patch({year:e.target.value?Number(e.target.value):null})}/></label>
          <label>Edition<input maxLength={100} value={draft.book.edition} onChange={e=>patch({edition:e.target.value})}/></label>
          <label>ISBN<input maxLength={30} value={draft.book.isbn} onChange={e=>patch({isbn:e.target.value})}/></label>
          <label className="span-two">Public book information URL<input type="url" maxLength={1500} value={draft.book.url} onChange={e=>patch({url:e.target.value})}/></label>
          <label className="span-two">Geographic and subject coverage<textarea maxLength={1500} rows={3} value={draft.book.coverage} onChange={e=>patch({coverage:e.target.value})}/></label>
          <label>Register status<select value={draft.book.state} onChange={e=>patch({state:e.target.value as Book['state']})}><option value="active">Active</option><option value="archived">Archived</option></select></label>
        </div></fieldset>
        <fieldset disabled={busy}><legend>Credibility</legend><div className="book-fields">
          <label>Assessment<select value={draft.book.credibility.classification} onChange={e=>credibility({classification:e.target.value as Book['credibility']['classification']})}><option value="unassessed">Not assessed</option><option value="expert_reference">Expert reference, not official boundary data</option></select></label>
          <label className="span-two">Public assessment rationale<textarea rows={3} maxLength={2000} value={draft.book.credibility.rationale} onChange={e=>credibility({rationale:e.target.value})}/></label>
          <label className="span-two">Public assessment evidence URLs<textarea rows={2} value={draft.book.credibility.evidenceUrls.join('\n')} onChange={e=>credibility({evidenceUrls:e.target.value.split('\n')})}/></label>
        </div></fieldset>
        <fieldset disabled={busy}><legend>Rights and permitted uses</legend><div className="book-fields">
          <label className="span-two">Rights record<select value={draft.book.rights.mode} onChange={e=>{const mode=e.target.value as Book['rights']['mode'];rights({mode,...(mode==='permission_recorded'?{basis:'written_permission'}:{basis:'unverified',scopeChecked:false,commercialUse:'unverified',permissions:{text:false,images:false,mapDigitisation:false,aiProcessing:false}})});}}><option value="reference_only">Reference only; reproduction rights unverified</option><option value="permission_recorded">Permission recorded for specified uses</option><option value="restricted">Reuse restricted</option></select></label>
          <label>Rights holder<input maxLength={200} value={draft.book.rights.holder} onChange={e=>rights({holder:e.target.value})}/></label>
          <label>Permission basis<select disabled={draft.book.rights.mode!=='permission_recorded'} value={draft.book.rights.basis} onChange={e=>rights({basis:e.target.value as Book['rights']['basis']})}><option value="unverified">Not verified</option><option value="written_permission">Written permission</option><option value="open_licence">Open licence</option></select></label>
          <label>Licence name<input maxLength={200} value={draft.book.rights.licence} onChange={e=>rights({licence:e.target.value})}/></label>
          <label>Public licence URL<input type="url" maxLength={1500} value={draft.book.rights.licenceUrl} onChange={e=>rights({licenceUrl:e.target.value})}/></label>
          <label className="span-two">Private permission evidence / document reference<textarea rows={3} maxLength={3000} value={draft.book.rights.permissionEvidence} onChange={e=>rights({permissionEvidence:e.target.value})}/></label>
          <label className="span-two">Private scope, covered assets and exclusions<textarea rows={3} maxLength={3000} value={draft.book.rights.scope} onChange={e=>rights({scope:e.target.value})}/></label>
          <label>Permission valid through<input type="date" value={draft.book.rights.validUntil} onChange={e=>rights({validUntil:e.target.value})}/></label>
          <label>Commercial reuse<select disabled={draft.book.rights.mode!=='permission_recorded'} value={draft.book.rights.commercialUse} onChange={e=>rights({commercialUse:e.target.value as Book['rights']['commercialUse']})}><option value="unverified">Not established</option><option value="permitted">Permitted within recorded scope</option><option value="prohibited">Prohibited</option></select></label>
          <div className="span-two book-permissions">{Object.entries(permissionNames).map(([key,label])=><label className="book-check" key={key}><input type="checkbox" disabled={draft.book.rights.mode!=='permission_recorded'} checked={draft.book.rights.permissions[key as keyof BookPermissions]} onChange={e=>rights({permissions:{...draft.book.rights.permissions,[key]:e.target.checked}})}/>{label}</label>)}</div>
          {draft.book.rights.mode==='permission_recorded'&&<label className="span-two book-check"><input type="checkbox" required checked={draft.book.rights.scopeChecked} onChange={e=>rights({scopeChecked:e.target.checked})}/>I checked the permission scope and any third-party asset exclusions.</label>}
          <p className="span-two small muted">Rights records do not enable book uploads, copying, AI ingestion or geometry imports. Source approvals remain separate.</p>
        </div></fieldset>
        <label>Change reason<textarea required minLength={5} maxLength={1000} rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>
        <div className="book-form-actions"><button className="primary" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Save size={16}/>}Save book record</button></div>
        {!!draft.history?.length&&<details><summary>Book record history ({draft.history.length})</summary>{draft.history.map(h=><details key={h.version}><summary>Revision {h.version} · {stamp(h.created)}</summary><p className="small">{h.reason}</p><pre>{JSON.stringify(h.book,null,2)}</pre></details>)}</details>}
      </form>}
    </div></div>:<section className="book-feature-references" aria-label="Feature book references">
      <div className="book-feature-picker"><label className="book-filter"><Search size={16}/><input aria-label="Filter reference features" value={featureFilter} placeholder="Filter features" onChange={e=>setFeatureFilter(e.target.value)}/></label>
        <label>Feature<select aria-label="Reference feature" value={featureId} onChange={e=>{setFeatureId(e.target.value);setNotice('');setError('');}}><option value="">Select a mapped feature</option>{features.filter(f=>f.id===featureId||`${f.displayName||f.name} ${f.type}`.toLowerCase().includes(featureFilter.toLowerCase())).map(f=><option key={f.id} value={f.id}>{f.displayName||f.name} · {statusLabel(f.type)}</option>)}</select></label>
      </div>
      {selected&&<><div className="section-heading"><div><h3>{selected.displayName||selected.name}</h3><p className="small muted">Current geometry revision: {selected.revisionId}</p></div><div className="book-row-actions"><a className="text-button" href={`/?job=${encodeURIComponent(selected.jobId)}`}>View map<ArrowUpRight size={14}/></a><button className="secondary small-button" disabled={busy||citationLoading||!activeBooks.length} onClick={newCitation}><Plus size={15}/>Add reference note</button></div></div>
        {citationLoading?<p role="status">Loading reference notes...</p>:!citations.length&&<p className="muted small">No book references attached to this feature.</p>}
        {citations.map(row=><article key={row.id} className="book-citation-row"><div className="book-editor-heading"><div><h3>{row.bookTitle}</h3><p className="small muted">{row.citation.locator} · {row.currentGeometry?'Current geometry':'Earlier geometry revision'} · {row.state==='published'?'Published':'Withdrawn'}</p></div>
          <div className="book-row-actions"><button type="button" className="icon-button" aria-label={`Edit reference ${row.citation.locator}`} title="Edit reference note" disabled={busy||!row.currentGeometry} onClick={()=>{setCitationDraft({id:row.id,version:row.version,citation:{...row.citation,originalWording:false,publishConfirmed:false}});setCitationReason('');}}><Pencil size={16}/></button>
          {row.state==='published'&&<button type="button" className="secondary small-button" disabled={busy} onClick={()=>{setWithdrawing(row);setWithdrawReason('');}}><Undo2 size={14}/>Withdraw</button>}</div></div>
          <p>{row.citation.claim}</p><p className="small muted">{row.citation.limitations}</p>
          <details><summary>Reference history ({row.history.length})</summary>{row.history.map(h=><details key={h.version}><summary>Revision {h.version} · {stamp(h.created)}</summary><p className="small">{h.reason}</p><pre>{JSON.stringify(h.data,null,2)}</pre></details>)}</details>
        </article>)}
      </>}
      {withdrawing&&<form className="book-annotation-form" onSubmit={e=>{e.preventDefault();action(async()=>{await api(`/admin/book-citations/${withdrawing.id}/withdraw`,'POST',{version:withdrawing.version,reason:withdrawReason});setWithdrawing(null);await refreshCitations();setNotice('Reference note withdrawn. Geometry and history are unchanged.');});}}><h3>Withdraw reference: {withdrawing.citation.locator}</h3><label>Withdrawal reason<textarea required minLength={5} maxLength={1000} value={withdrawReason} onChange={e=>setWithdrawReason(e.target.value)}/></label><div className="book-form-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>setWithdrawing(null)}>Cancel</button><button className="primary" disabled={busy}><Undo2 size={15}/>Withdraw reference</button></div></form>}
      {citationDraft&&<form className="book-annotation-form" onSubmit={publishCitation} aria-label="Feature reference editor"><h3>{citationDraft.id?'Edit reference note':'New reference note'}</h3><p className="small muted">Geometry revision: {citationDraft.citation.revisionId}</p><div className="book-fields">
        <label className="span-two">Book<select required aria-label="Citation book" disabled={!!citationDraft.id} value={citationDraft.citation.bookId} onChange={e=>{const b=books.find(b=>b.id===e.target.value);changeCitation({bookId:e.target.value,bookVersion:b?.version||0});}}><option value="">Select a book</option>{books.filter(b=>b.book.state==='active'||b.id===citationDraft.citation.bookId).map(b=><option key={b.id} disabled={b.book.state==='archived'} value={b.id}>{b.book.title} · record revision {b.version}{b.book.state==='archived'?' (archived)':''}</option>)}</select></label>
        {citationDraft.citation.bookId&&<div className="span-two small muted">Cited book record revision {citationDraft.citation.bookVersion}{books.find(b=>b.id===citationDraft.citation.bookId)?.version!==citationDraft.citation.bookVersion&&<button type="button" className="text-button" onClick={()=>changeCitation({bookVersion:books.find(b=>b.id===citationDraft.citation.bookId)!.version})}>Use current book record</button>}</div>}
        <label>Pages, chapter or figure reference<input required maxLength={200} value={citationDraft.citation.locator} onChange={e=>changeCitation({locator:e.target.value})}/></label>
        <label>Reference role<select value={citationDraft.citation.relationship} onChange={e=>changeCitation({relationship:e.target.value as CitationInput['relationship']})}><option value="context">Geographic context</option><option value="interpretation">Interpretation context</option><option value="method_context">Method context</option></select></label>
        <label className="span-two">Supported fact or interpretation, in your own words<textarea required minLength={10} maxLength={1500} rows={4} value={citationDraft.citation.claim} onChange={e=>changeCitation({claim:e.target.value})}/></label>
        <label className="span-two">Limits of what this reference supports<textarea required minLength={10} maxLength={1500} rows={3} value={citationDraft.citation.limitations} onChange={e=>changeCitation({limitations:e.target.value})}/></label>
        <label className="span-two">Change reason<textarea required minLength={5} maxLength={1000} rows={2} value={citationReason} onChange={e=>setCitationReason(e.target.value)}/></label>
        <label className="span-two book-check"><input type="checkbox" required checked={citationDraft.citation.originalWording} onChange={e=>changeCitation({originalWording:e.target.checked})}/>This note uses my own wording, not a copied passage, map or illustration.</label>
        <label className="span-two book-check"><input type="checkbox" required checked={citationDraft.citation.publishConfirmed} onChange={e=>changeCitation({publishConfirmed:e.target.checked})}/>Publish this annotation under “How this was mapped” for this geometry revision.</label>
      </div><div className="book-form-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>setCitationDraft(null)}>Cancel</button><button className="primary" disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:<Save size={16}/>}Publish reference note</button></div></form>}
    </section>}
  </section>;
}
