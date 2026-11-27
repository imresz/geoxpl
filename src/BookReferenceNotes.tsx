import { ArrowUpRight,BookOpen } from 'lucide-react';
import type { PublicBookCitation } from './book-reference-types';
import './book-references.css';

export function BookReferenceNotes({references}:{references:PublicBookCitation[]}) {
  return <section className="book-reference-notes"><h3><BookOpen size={16}/>Book references</h3>
    {!references.length&&<p className="muted small">No reference annotations for this geometry revision.</p>}
    {references.map(ref=><article key={ref.id} className="book-reference-note">
      <strong>{ref.book.title}</strong><p className="small muted">{ref.book.authors.join('; ')}{ref.book.year?` (${ref.book.year})`:''}{ref.book.edition?` · ${ref.book.edition}`:''}</p>
      <p className="small">{ref.book.publisher}{ref.book.isbn?` · ISBN ${ref.book.isbn}`:''}</p>
      <dl><dt>Pages / chapter</dt><dd>{ref.locator}</dd><dt>Reference role</dt><dd>{{context:'Geographic context',interpretation:'Interpretation context',method_context:'Method context'}[ref.relationship]||ref.relationship}</dd></dl>
      <p className="book-claim">{ref.claim}</p><p className="small">{ref.limitations}</p>
      {ref.book.url&&<a className="source-link" href={ref.book.url} target="_blank" rel="noreferrer">Book information<ArrowUpRight size={14}/></a>}
      <details><summary>Reference credibility and rights</summary><p className="small">{ref.book.credibility.classification==='expert_reference'?'Expert reference, not official boundary data':'Credibility not assessed'}</p>
        <p className="small">{ref.book.credibility.rationale}</p>{ref.book.credibility.evidenceUrls.map((url,i)=><a className="source-link" href={url} key={url} target="_blank" rel="noreferrer">Assessment reference {i+1}<ArrowUpRight size={14}/></a>)}
        <p className="small">{ref.book.rights.label}</p>{ref.book.rights.licence&&<p className="small">{ref.book.rights.licence}</p>}
        {ref.book.rights.licenceUrl&&<a className="source-link" href={ref.book.rights.licenceUrl} target="_blank" rel="noreferrer">Licence terms<ArrowUpRight size={14}/></a>}
        <p className="small muted">Book metadata revision {ref.book.version}. Rights status reflects the current register.</p>
        {ref.book.currentVersion!==ref.book.version&&<p className="small muted">A newer book record exists. This annotation retains its cited metadata revision.</p>}
      </details>
      <p className="small muted">Added {new Date(ref.created).toLocaleDateString()}. {ref.note}</p>
    </article>)}
  </section>;
}
