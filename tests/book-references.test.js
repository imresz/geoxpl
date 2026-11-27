import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { sourceSchema } from '../server/research.js';
import { initialBook,initialBookId,getBook,listBooks,bookDetail,saveBook,bookSchema,bookRights,saveBookCitation,getBookCitation,listBookCitations,
  publicBookCitations,withdrawBookCitation,bookReferenceCount } from '../server/book-references.js';

const clone=value=>structuredClone(value);
const write=(store,book,id=null,version=0)=>saveBook(store,id,{book,version,reason:'Synthetic test change'});
function fixtureBook(label='Synthetic landforms') {return {...clone(initialBook),title:label,isbn:'',authors:['Synthetic Author'],year:2020,credibility:{classification:'unassessed',rationale:'',evidenceUrls:[]}};}
function fixtureFeature(store,name='Synthetic Valley') {
  const job=store.request(name,'valley');
  const feature=store.saveFeature(job,{status:'partially_resolved',method:'synthetic_test_only',algorithmVersion:'test/1',warnings:[],evidence:[],geometry:{type:'Polygon',coordinates:[[[145,-37],[145.01,-37],[145.01,-36.99],[145,-36.99],[145,-37]]]}});
  store.updateJob(job.id,'partially_resolved','completed','Synthetic fixture only',feature.id);
  return {job,feature,revisionId:store.featureRevisions(feature.id)[0].id};
}
function input(store,f,book=getBook(store,initialBookId)) {
  return {version:0,reason:'Synthetic citation for tests',citation:{featureId:f.feature.id,revisionId:f.revisionId,bookId:book.id,bookVersion:book.version,
    locator:'Synthetic chapter 1',relationship:'context',claim:'Synthetic factual context for this test feature only.',limitations:'This synthetic note does not define or validate a boundary.',originalWording:true,publishConfirmed:true}};
}
const unchanged=store=>JSON.stringify(['features','derivations','jobs','sources','imports'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

test('startup seeds one reference-only book without claiming pages, importing content or approving a geometry source',()=>{
  const store=createStore(':memory:');try{
    assert.equal(listBooks(store).length,1);const book=getBook(store,initialBookId);
    assert.equal(book.book.isbn,'9780959910551');assert.equal(book.book.rights.mode,'reference_only');
    assert.deepEqual(Object.values(book.book.rights.permissions),[false,false,false,false]);
    assert.equal(book.book.credibility.classification,'expert_reference');assert.equal(store.sources().length,0);assert.equal(store.features().length,0);
    assert.equal(listBookCitations(store).length,0);assert.equal(bookDetail(store,book.id).history.length,1);
    assert.equal(sourceSchema.safeParse({...book.book,type:'book',format:'book'}).success,false);
  }finally{store.close();}
});

test('additional books and corrections are versioned; stale saves and duplicate editions are rejected atomically',()=>{
  const store=createStore(':memory:');try{
    const first=write(store,fixtureBook()),updated=write(store,{...first.book,publisher:'Synthetic Publisher'},first.id,1);
    assert.equal(updated.version,2);assert.equal(bookDetail(store,first.id).history[1].book.publisher,'Costermans Publishing');
    assert.throws(()=>write(store,first.book,first.id,1),/changed/);
    assert.throws(()=>write(store,fixtureBook()),/already registered/);
    assert.throws(()=>write(store,{...fixtureBook('Other title'),isbn:initialBook.isbn}),/already registered/);
    assert.equal(listBooks(store).length,2);assert.equal(bookDetail(store,first.id).history.length,2);
    assert.equal(write(store,{...fixtureBook(),edition:'Second edition'}).version,1);
  }finally{store.close();}
});

test('rights metadata cannot grant copying or AI permissions without documented scope and acknowledgement',()=>{
  const base=fixtureBook();
  for(const permission of ['text','images','mapDigitisation','aiProcessing']) {
    const b=clone(base);b.rights.permissions[permission]=true;assert.throws(()=>bookSchema.parse(b),/cannot grant/);
  }
  const bad=clone(base);bad.rights.mode='permission_recorded';assert.throws(()=>bookSchema.parse(bad),/Record the rights holder/);
  const grant=clone(base);Object.assign(grant.rights,{mode:'permission_recorded',basis:'written_permission',holder:'Synthetic rights holder',permissionEvidence:'Private test-only permission document reference',
    scope:'Only a synthetic test illustration, not any third-party material.',scopeChecked:true,permissions:{text:false,images:true,mapDigitisation:false,aiProcessing:false}});
  assert.equal(bookSchema.parse(grant).rights.permissions.images,true);
  assert.equal(bookRights(grant,'2026-11-26').permissions.aiProcessing,false);
  grant.rights.validUntil='2026-11-25';assert.equal(bookRights(grant,'2026-11-26').status,'expired');assert.equal(bookRights(grant,'2026-11-26').permissions.images,false);
  assert.equal(bookRights(grant,'2026-11-25').permissions.images,true);
  grant.state='archived';assert.equal(bookRights(grant,'2026-11-25').permissions.images,false);
  grant.rights.basis='open_licence';assert.throws(()=>bookSchema.parse(grant),/Record the rights holder/);
});

test('book validation rejects unsafe links, malformed dates, invalid ISBNs and unsupported official-boundary classifications',()=>{
  for(const isbn of ['9780959910552','123','978095991055X'])assert.throws(()=>bookSchema.parse({...fixtureBook(),isbn}),/ISBN/);
  assert.equal(bookSchema.parse({...fixtureBook(),isbn:'978-0-9599105-5-1'}).isbn,initialBook.isbn);
  for(const url of ['javascript:alert(1)','http://example.com','https://user:password@example.com'])assert.throws(()=>bookSchema.parse({...fixtureBook(),url}));
  const date=fixtureBook();date.rights.validUntil='2026-02-30';assert.throws(()=>bookSchema.parse(date),/valid YYYY/);
  assert.throws(()=>bookSchema.parse({...fixtureBook(),credibility:{classification:'official_boundary',rationale:'Unsupported',evidenceUrls:[]}}));
});

test('reference notes require page locators, own wording, explicit publication and an exact current geometry revision',()=>{
  const store=createStore(':memory:');try{
    const f=fixtureFeature(store),body=input(store,f);
    for(const field of ['originalWording','publishConfirmed'])assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,[field]:false}}));
    assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,locator:''}}));
    assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,revisionId:randomUUID()}}),/geometry changed/);
    const other=fixtureFeature(store,'Other valley');assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,revisionId:other.revisionId}}),/geometry changed/);
    const first=saveBookCitation(store,null,body);assert.equal(bookReferenceCount(store,f.feature.id),1);
    assert.equal(saveBookCitation(store,null,body).id,first.id);assert.equal(listBookCitations(store).length,1);
  }finally{store.close();}
});

test('adding, correcting and withdrawing reference annotations never changes geometry, derivations, jobs or source approvals',()=>{
  const store=createStore(':memory:');try{
    const f=fixtureFeature(store),before=unchanged(store),body=input(store,f),first=saveBookCitation(store,null,body);
    assert.equal(unchanged(store),before);
    const corrected=saveBookCitation(store,first.id,{...body,version:1,citation:{...body.citation,locator:'Synthetic chapter 2'}});
    assert.equal(corrected.version,2);assert.equal(listBookCitations(store)[0].history.length,2);
    assert.throws(()=>saveBookCitation(store,first.id,{...body,version:1}),/changed/);
    withdrawBookCitation(store,first.id,{version:2,reason:'Synthetic correction withdrawn'});
    assert.equal(publicBookCitations(store,f.feature.id,f.revisionId).length,0);
    assert.equal(listBookCitations(store)[0].history.length,3);assert.equal(unchanged(store),before);
    assert.equal(getBookCitation(store,first.id).state,'withdrawn');
  }finally{store.close();}
});

test('reprocessing does not carry a citation onto new geometry, and historical notes cannot be moved',()=>{
  const store=createStore(':memory:');try{
    const f=fixtureFeature(store),body=input(store,f),note=saveBookCitation(store,null,body);
    store.saveFeature(f.job,{...f.feature,algorithmVersion:'test/2'});const latest=store.featureRevisions(f.feature.id)[0].id;
    assert.notEqual(latest,f.revisionId);assert.equal(publicBookCitations(store,f.feature.id,latest).length,0);
    assert.equal(publicBookCitations(store,f.feature.id,f.revisionId).length,1);
    assert.throws(()=>saveBookCitation(store,null,body),/geometry changed/);
    assert.throws(()=>saveBookCitation(store,note.id,{...body,version:1,citation:{...body.citation,revisionId:latest}}),/cannot be moved/);
    assert.equal(listBookCitations(store)[0].currentGeometry,false);
    withdrawBookCitation(store,note.id,{version:1,reason:'Historical citation withdrawal'});
  }finally{store.close();}
});

test('citations pin their book metadata version but public rights reflect later restriction without leaking private grant evidence',()=>{
  const store=createStore(':memory:');try{
    const f=fixtureFeature(store),book=write(store,fixtureBook()),body=input(store,f,book);saveBookCitation(store,null,body);
    const next=clone(book.book);next.publisher='Corrected publisher';next.rights.mode='restricted';next.rights.permissionEvidence='PRIVATE-EVIDENCE-DO-NOT-PUBLISH';next.rights.scope='PRIVATE-SCOPE-DO-NOT-PUBLISH';
    write(store,next,book.id,1);
    const ref=publicBookCitations(store,f.feature.id,f.revisionId)[0];
    assert.equal(ref.book.version,1);assert.equal(ref.book.currentVersion,2);assert.equal(ref.book.publisher,'Costermans Publishing');assert.equal(ref.book.rights.status,'restricted');
    assert.equal(JSON.stringify(ref).includes('PRIVATE-'),false);assert.match(ref.note,/Not an original processing input/);
    assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,claim:'Another synthetic claim for these test records.'}}),/book record changed/);
  }finally{store.close();}
});

test('archiving is reversible, keeps old citations, and prevents new references until restored',()=>{
  const store=createStore(':memory:');try{
    const f=fixtureFeature(store),book=write(store,fixtureBook()),body=input(store,f,book);saveBookCitation(store,null,body);
    const archived=write(store,{...book.book,state:'archived'},book.id,1);
    assert.equal(publicBookCitations(store,f.feature.id,f.revisionId)[0].book.rights.status,'archived');
    assert.throws(()=>saveBookCitation(store,null,{...body,citation:{...body.citation,bookVersion:archived.version}}),/archived/);
    const restored=write(store,{...book.book,state:'active'},book.id,2);assert.equal(restored.version,3);assert.equal(listBookCitations(store).length,1);
  }finally{store.close();}
});

test('book edits, archive state, citation revisions and the initial seed survive restart without overwriting user changes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'geoxpl-books-')),path=join(dir,'test.sqlite');let store=createStore(path);
  try{
    const seed=getBook(store,initialBookId);write(store,{...seed.book,state:'archived',coverage:'A user-maintained scope note.'},seed.id,1);
    const other=write(store,fixtureBook()),f=fixtureFeature(store);const note=saveBookCitation(store,null,input(store,f,other));
    store.close();store=createStore(path);
    assert.equal(listBooks(store).length,2);assert.equal(getBook(store,initialBookId).book.state,'archived');
    assert.equal(getBook(store,initialBookId).book.coverage,'A user-maintained scope note.');assert.equal(getBookCitation(store,note.id).version,1);
    assert.equal(bookDetail(store,initialBookId).history.length,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('all book administration endpoints are authenticated; public panels expose only revision-matched published notes',async()=>{
  const store=createStore(':memory:'),f=fixtureFeature(store),server=createApp(store).listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));const root=`http://127.0.0.1:${server.address().port}/api`;
    const send=(path,method='GET',body,cookie,origin)=>fetch(root+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
    for(const [path,method] of [['/admin/books','GET'],[`/admin/books/${initialBookId}`,'GET'],['/admin/books','POST'],[`/admin/books/${initialBookId}`,'PUT'],['/admin/book-reference-features','GET'],['/admin/book-citations','GET'],['/admin/book-citations','POST'],[`/admin/book-citations/${randomUUID()}`,'PUT'],[`/admin/book-citations/${randomUUID()}/withdraw`,'POST']])assert.equal((await send(path,method,method==='GET'?undefined:{})).status,401);
    assert.equal((await send(`/features/${f.feature.id}/provenance`)).status,404);
    const setup=await send('/admin/setup','POST',{password:'Synthetic test password only 123'});const cookie=setup.headers.get('set-cookie').split(';')[0];
    const books=await (await send('/admin/books','GET',undefined,cookie)).json();assert.equal(books.length,1);
    assert.equal((await send('/admin/books','POST',{version:0,book:fixtureBook(),reason:'Synthetic CSRF test'},cookie,'https://other.example')).status,403);
    const published=await send('/admin/book-citations','POST',input(store,f),cookie);assert.equal(published.status,200);const note=await published.json();
    const feature=await (await send(`/features/${f.feature.id}`)).json();assert.equal(feature.bookReferenceCount,1);
    const history=await (await send(`/features/${f.feature.id}/provenance`)).json();assert.equal(history.bookReferences[0].book.id,initialBookId);
    assert.equal(history.bookReferences[0].book.rights.status,'reference_only');assert.equal(history.bookReferences[0].book.rights.permissionEvidence,undefined);
    const cross=fixtureFeature(store,'Another synthetic valley');assert.equal((await send(`/features/${f.feature.id}/provenance?revision=${cross.revisionId}`)).status,404);
    store.saveFeature(f.job,{...f.feature,algorithmVersion:'test/2'});
    const current=await (await send(`/features/${f.feature.id}/provenance`)).json();assert.deepEqual(current.bookReferences,[]);
    const old=await (await send(`/features/${f.feature.id}/provenance?revision=${f.revisionId}`)).json();assert.equal(old.bookReferences.length,1);
    assert.equal((await send(`/admin/book-citations/${note.id}/withdraw`,'POST',{version:note.version,reason:'Synthetic API withdrawal'},cookie)).status,200);
    assert.equal((await send(`/features/${f.feature.id}/provenance`)).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
