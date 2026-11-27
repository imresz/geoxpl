import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const now=()=>new Date().toISOString();
const text=max=>z.string().trim().max(max);
const link=z.url().max(1500).refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'Use an HTTPS link without credentials.');
const optionalLink=link.or(z.literal(''));
const date=text(10).refine(value=>!value||(/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value),'Use a valid YYYY-MM-DD date.');
const permissions=z.object({text:z.boolean(),images:z.boolean(),mapDigitisation:z.boolean(),aiProcessing:z.boolean()}).strict();
export const noBookPermissions={text:false,images:false,mapDigitisation:false,aiProcessing:false};
function validIsbn(value) {
  if(!value)return true;
  if(/^\d{13}$/.test(value))return [...value].reduce((sum,d,i)=>sum+Number(d)*(i%2?3:1),0)%10===0;
  return /^\d{9}[\dX]$/.test(value)&&[...value].reduce((sum,d,i)=>sum+(d==='X'?10:Number(d))*(10-i),0)%11===0;
}
export const bookSchema=z.object({
  title:text(300).min(3),authors:z.array(text(120).min(2)).min(1).max(20),publisher:text(200),year:z.number().int().min(1000).max(2100).nullable(),
  edition:text(100),isbn:text(30).transform(s=>s.replace(/[\s-]/g,'').toUpperCase()).refine(validIsbn,'ISBN check digit is invalid.'),
  url:optionalLink,coverage:text(1500),state:z.enum(['active','archived']),
  credibility:z.object({classification:z.enum(['unassessed','expert_reference']),rationale:text(2000),evidenceUrls:z.array(link).max(8)}).strict(),
  rights:z.object({mode:z.enum(['reference_only','permission_recorded','restricted']),basis:z.enum(['unverified','written_permission','open_licence']),
    holder:text(200),licence:text(200),licenceUrl:optionalLink,permissionEvidence:text(3000),scope:text(3000),validUntil:date,
    commercialUse:z.enum(['unverified','permitted','prohibited']),scopeChecked:z.boolean(),permissions}).strict()
}).strict().superRefine((book,ctx)=>{
  if(new Set(book.authors.map(a=>a.toLowerCase())).size!==book.authors.length)ctx.addIssue({code:'custom',message:'Authors must not be duplicated.'});
  if(book.credibility.classification==='expert_reference'&&(book.credibility.rationale.length<10||!book.credibility.evidenceUrls.length))ctx.addIssue({code:'custom',message:'An expert assessment needs a rationale and supporting reference.'});
  const r=book.rights;
  if(r.mode==='permission_recorded') {
    if(r.basis==='unverified'||r.holder.length<2||r.permissionEvidence.length<10||r.scope.length<10||!r.scopeChecked||!Object.values(r.permissions).some(Boolean)||
      (r.basis==='open_licence'&&(!r.licence||!r.licenceUrl)))ctx.addIssue({code:'custom',message:'Record the rights holder, permission evidence, scope and checked uses before recording permission.'});
  }else if(Object.values(r.permissions).some(Boolean)||r.commercialUse==='permitted'||r.basis!=='unverified'||r.scopeChecked) {
    ctx.addIssue({code:'custom',message:'Reference-only or restricted records cannot grant reproduction or AI-processing permission.'});
  }
});
const writeSchema=z.object({version:z.number().int().min(0),reason:text(1000).min(5),book:bookSchema}).strict();
const citationSchema=z.object({featureId:z.uuid(),revisionId:z.uuid(),bookId:z.uuid(),bookVersion:z.number().int().positive(),
  locator:text(200).min(1),relationship:z.enum(['context','interpretation','method_context']),claim:text(1500).min(10),limitations:text(1500).min(10),
  originalWording:z.literal(true),publishConfirmed:z.literal(true)}).strict();
const citationWrite=z.object({version:z.number().int().min(0),reason:text(1000).min(5),citation:citationSchema}).strict();
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const transaction=(db,fn)=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
const normal=value=>value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
const workKey=b=>JSON.stringify([normal(b.title),b.authors.map(normal),b.year,normal(b.edition)]);
const bookRow=row=>row?{id:row.id,version:row.version,created:row.created,updated:row.updated,book:JSON.parse(row.data)}:null;
export const getBook=(store,id)=>bookRow(store.db.prepare('SELECT * FROM books WHERE id=?').get(id));
export const listBooks=store=>store.db.prepare('SELECT * FROM books ORDER BY json_extract(data,\'$.title\') COLLATE NOCASE').all().map(bookRow);
export function bookDetail(store,id) {
  const book=getBook(store,id);if(!book)fail('Book not found.',404);
  return {...book,history:store.db.prepare('SELECT version,data,reason,created FROM book_revisions WHERE book_id=? ORDER BY version DESC').all(id).map(r=>({...r,book:JSON.parse(r.data),data:undefined}))};
}

export function bookRights(book,today=now().slice(0,10)) {
  const r=book.rights,expired=r.mode==='permission_recorded'&&!!r.validUntil&&r.validUntil<today;
  const effective=book.state==='active'&&r.mode==='permission_recorded'&&!expired;
  return {status:book.state==='archived'?'archived':expired?'expired':r.mode,
    label:book.state==='archived'?'Archived reference':expired?'Recorded permission expired':r.mode==='permission_recorded'?'Permission recorded for specified uses':r.mode==='restricted'?'Reuse restricted':'Reference only; reproduction rights unverified',
    permissions:effective?r.permissions:{...noBookPermissions},commercialUse:effective?r.commercialUse:'unverified',
    licence:effective?r.licence:'',licenceUrl:effective?r.licenceUrl:'',validUntil:r.validUntil};
}
export function publicBook(record,current=record) {
  const b=record.book;
  return {id:record.id,version:record.version,title:b.title,authors:b.authors,publisher:b.publisher,year:b.year,edition:b.edition,isbn:b.isbn,url:b.url,
    credibility:b.credibility,currentVersion:current.version,rights:bookRights(current.book)};
}

export function saveBook(store,id,raw) {
  const input=writeSchema.parse(raw),db=store.db;
  return transaction(db,()=>{
    const old=id?getBook(store,id):null;
    if(id&&!old)fail('Book not found.',404);
    if((old?.version||0)!==input.version)fail('The book record changed. Reload it before saving.');
    const duplicate=db.prepare('SELECT id FROM books WHERE (isbn=? OR work_key=?) AND id<>?').get(input.book.isbn||null,workKey(input.book),id||'');
    if(duplicate)fail('This book edition is already registered. Edit its existing record.');
    const bookId=id||randomUUID(),version=input.version+1,timestamp=now(),data=JSON.stringify(input.book);
    db.prepare(`INSERT INTO books VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,isbn=excluded.isbn,work_key=excluded.work_key,data=excluded.data,updated=excluded.updated`)
      .run(bookId,version,input.book.isbn||null,workKey(input.book),data,old?.created||timestamp,timestamp);
    db.prepare('INSERT INTO book_revisions VALUES(?,?,?,?,?)').run(bookId,version,data,input.reason,timestamp);
    store.event(null,'book_reference_saved',`${bookId}: metadata/rights revision ${version}`);
    return getBook(store,bookId);
  });
}

export const initialBookId='1a819779-cf19-4f5c-bb8f-c68645ee40b7';
export const initialBook={
  title:'Stories beneath our feet: Exploring the geology and landscapes of Victoria and surrounds',
  authors:['Leon Costermans','Fons VandenBerg'],publisher:'Costermans Publishing',year:2022,edition:'',isbn:'9780959910551',
  url:'https://connectingcountry.s3.ap-southeast-2.amazonaws.com/press/wp-content/uploads/2022/11/28163835/SBOF-flyer.pdf',
  coverage:'Geology and landscape interpretation in Victoria and surrounding southeastern Australia. No feature-specific page references have been reviewed in GeoXpl.',state:'active',
  credibility:{classification:'expert_reference',rationale:'Expert geological context, not official boundary data. The Geological Society of Australia documents VandenBerg\'s Geological Survey of Victoria mapping and stratigraphic expertise. This assessment does not verify every interpretation or extent in the book.',
    evidenceUrls:['https://www.gsavic.org/howitt-lecture-2020.html']},
  rights:{mode:'reference_only',basis:'unverified',holder:'',licence:'',licenceUrl:'',permissionEvidence:'No open reuse licence or book copyright page has been verified.',
    scope:'Bibliographic reference and independently worded factual research only. No book content or feature-specific claim has been imported.',validUntil:'',commercialUse:'unverified',scopeChecked:false,permissions:{...noBookPermissions}}
};
export function initialiseBookReferences(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,version INTEGER NOT NULL,isbn TEXT UNIQUE,work_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS book_revisions(book_id TEXT NOT NULL REFERENCES books(id),version INTEGER NOT NULL,data TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(book_id,version));
    CREATE TABLE IF NOT EXISTS book_citations(id TEXT PRIMARY KEY,feature_id TEXT NOT NULL REFERENCES features(id),revision_id TEXT NOT NULL REFERENCES derivations(id),book_id TEXT NOT NULL,book_version INTEGER NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,FOREIGN KEY(book_id,book_version) REFERENCES book_revisions(book_id,version));
    CREATE INDEX IF NOT EXISTS book_citations_feature ON book_citations(feature_id,revision_id,state);
    CREATE TABLE IF NOT EXISTS book_citation_revisions(citation_id TEXT NOT NULL REFERENCES book_citations(id),version INTEGER NOT NULL,data TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(citation_id,version));`);
  if(!getBook(store,initialBookId)) {
    const book=bookSchema.parse(initialBook),timestamp=now(),data=JSON.stringify(book);
    transaction(store.db,()=>{
      store.db.prepare('INSERT OR IGNORE INTO books VALUES(?,?,?,?,?,?,?)').run(initialBookId,1,book.isbn,workKey(book),data,timestamp,timestamp);
      if(getBook(store,initialBookId))store.db.prepare('INSERT OR IGNORE INTO book_revisions VALUES(?,?,?,?,?)').run(initialBookId,1,data,'Initial reference-only registration; no feature claims or content imported.',timestamp);
    });
  }
}

const citationRow=row=>row?{id:row.id,featureId:row.feature_id,revisionId:row.revision_id,bookId:row.book_id,bookVersion:row.book_version,version:row.version,state:row.state,
  citation:JSON.parse(row.data),created:row.created,updated:row.updated}:null;
export const getBookCitation=(store,id)=>citationRow(store.db.prepare('SELECT * FROM book_citations WHERE id=?').get(id));
export const bookReferenceCount=(store,featureId)=>store.db.prepare("SELECT COUNT(*) AS n FROM book_citations WHERE feature_id=? AND state='published'").get(featureId).n;
export const withBookReferenceCount=(store,feature)=>{if(!feature)return null;const count=bookReferenceCount(store,feature.id);return count?{...feature,bookReferenceCount:count}:feature;};
export function bookCitationFeatures(store) {
  return store.db.prepare(`SELECT f.id,j.id AS jobId,json_extract(f.data,'$.displayName') AS displayName,json_extract(f.data,'$.name') AS name,j.type,
    (SELECT d.id FROM derivations d WHERE d.feature_id=f.id ORDER BY d.rowid DESC LIMIT 1) AS revisionId
    FROM features f JOIN jobs j ON j.id=f.job_id WHERE f.active=1 AND j.superseded_by IS NULL ORDER BY j.normalized`).all();
}
export function listBookCitations(store,featureId) {
  return store.db.prepare(`SELECT * FROM book_citations ${featureId?'WHERE feature_id=?':''} ORDER BY created DESC`).all(...(featureId?[featureId]:[])).map(r=>{
    const citation=citationRow(r),book=getBook(store,r.book_id);
    const current=store.featureRevisions(r.feature_id)[0]?.id;
    return {...citation,bookTitle:book?.book.title,currentGeometry:current===r.revision_id,
      history:store.db.prepare('SELECT version,data,reason,created FROM book_citation_revisions WHERE citation_id=? ORDER BY version DESC').all(r.id).map(h=>({...h,data:JSON.parse(h.data)}))};
  });
}
export function saveBookCitation(store,id,raw) {
  const input=citationWrite.parse(raw),c=input.citation,db=store.db;
  return transaction(db,()=>{
    const old=id?getBookCitation(store,id):null;
    if(id&&!old)fail('Reference note not found.',404);
    if((old?.version||0)!==input.version)fail('The reference note changed. Reload it before saving.');
    if(old&&(old.featureId!==c.featureId||old.revisionId!==c.revisionId||old.bookId!==c.bookId))fail('A reference note cannot be moved to another feature, geometry revision or book. Create a new note.');
    const feature=store.feature(c.featureId),revision=store.featureRevisions(c.featureId)[0];
    if(!feature||revision?.id!==c.revisionId||!store.featureRevision(c.featureId,c.revisionId))fail('The current geometry changed or was withdrawn. Reload the feature before citing it.');
    const book=getBook(store,c.bookId);
    if(!book||book.book.state!=='active'||book.version!==c.bookVersion)fail('The book record changed or is archived. Reload the book before citing it.');
    const duplicate=!id&&db.prepare("SELECT id FROM book_citations WHERE feature_id=? AND revision_id=? AND book_id=? AND state='published' AND data=?").get(c.featureId,c.revisionId,c.bookId,JSON.stringify(c));
    if(duplicate)return getBookCitation(store,duplicate.id);
    const citationId=id||randomUUID(),version=input.version+1,timestamp=now(),data=JSON.stringify(c);
    db.prepare(`INSERT INTO book_citations VALUES(?,?,?,?,?,?,'published',?,?,?) ON CONFLICT(id) DO UPDATE SET book_version=excluded.book_version,version=excluded.version,state='published',data=excluded.data,updated=excluded.updated`)
      .run(citationId,c.featureId,c.revisionId,c.bookId,c.bookVersion,version,data,old?.created||timestamp,timestamp);
    const row=getBookCitation(store,citationId);
    db.prepare('INSERT INTO book_citation_revisions VALUES(?,?,?,?,?)').run(citationId,version,JSON.stringify(row),input.reason,timestamp);
    store.event(null,'book_citation_published',`${citationId}: reference note revision ${version}`);
    return row;
  });
}
export function withdrawBookCitation(store,id,raw) {
  const input=z.object({version:z.number().int().positive(),reason:text(1000).min(5)}).strict().parse(raw);
  return transaction(store.db,()=>{
    const old=getBookCitation(store,id);if(!old)fail('Reference note not found.',404);
    if(old.version!==input.version)fail('The reference note changed. Reload it before withdrawing.');
    if(old.state==='withdrawn')return old;
    const timestamp=now();
    store.db.prepare("UPDATE book_citations SET version=version+1,state='withdrawn',updated=? WHERE id=?").run(timestamp,id);
    const row=getBookCitation(store,id);
    store.db.prepare('INSERT INTO book_citation_revisions VALUES(?,?,?,?,?)').run(id,row.version,JSON.stringify(row),input.reason,timestamp);
    store.event(null,'book_citation_withdrawn',`${id}: reference note withdrawn`);return row;
  });
}
export function publicBookCitations(store,featureId,revisionId) {
  return store.db.prepare("SELECT * FROM book_citations WHERE feature_id=? AND revision_id=? AND state='published' ORDER BY created,id").all(featureId,revisionId).map(row=>{
    const saved=store.db.prepare('SELECT data FROM book_revisions WHERE book_id=? AND version=?').get(row.book_id,row.book_version),current=getBook(store,row.book_id);
    const c=JSON.parse(row.data);
    return {id:row.id,version:row.version,created:row.created,updated:row.updated,locator:c.locator,relationship:c.relationship,claim:c.claim,limitations:c.limitations,
      book:publicBook({id:row.book_id,version:row.book_version,book:JSON.parse(saved.data)},current),
      note:'Administrator-added reference annotation for this saved geometry revision. Not an original processing input, an author-defined boundary, or an endorsement by the authors.'};
  });
}
