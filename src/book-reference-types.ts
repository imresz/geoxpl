export type BookPermissions={text:boolean;images:boolean;mapDigitisation:boolean;aiProcessing:boolean};
export type Book={title:string;authors:string[];publisher:string;year:number|null;edition:string;isbn:string;url:string;coverage:string;state:'active'|'archived';
  credibility:{classification:'unassessed'|'expert_reference';rationale:string;evidenceUrls:string[]};
  rights:{mode:'reference_only'|'permission_recorded'|'restricted';basis:'unverified'|'written_permission'|'open_licence';holder:string;licence:string;licenceUrl:string;
    permissionEvidence:string;scope:string;validUntil:string;commercialUse:'unverified'|'permitted'|'prohibited';scopeChecked:boolean;permissions:BookPermissions}};
export type BookRecord={id:string;version:number;book:Book;created:string;updated:string;history?:{version:number;book:Book;reason:string;created:string}[]};
export type CitationInput={featureId:string;revisionId:string;bookId:string;bookVersion:number;locator:string;relationship:'context'|'interpretation'|'method_context';claim:string;limitations:string;originalWording:boolean;publishConfirmed:boolean};
export type BookCitation={id:string;version:number;state:string;featureId:string;revisionId:string;bookId:string;bookVersion:number;citation:CitationInput;created:string;updated:string;bookTitle:string;currentGeometry:boolean;
  history:{version:number;reason:string;created:string;data:unknown}[]};
export type PublicBookCitation={id:string;version:number;locator:string;relationship:CitationInput['relationship'];claim:string;limitations:string;note:string;created:string;updated:string;
  book:Pick<Book,'title'|'authors'|'year'|'edition'|'publisher'|'isbn'|'url'|'credibility'>&{id:string;version:number;currentVersion:number;rights:{label:string;status:string;licence:string;licenceUrl:string}}};
export const emptyBook=():Book=>({title:'',authors:[''],publisher:'',year:null,edition:'',isbn:'',url:'',coverage:'',state:'active',
  credibility:{classification:'unassessed',rationale:'',evidenceUrls:[]},
  rights:{mode:'reference_only',basis:'unverified',holder:'',licence:'',licenceUrl:'',permissionEvidence:'',scope:'',validUntil:'',commercialUse:'unverified',scopeChecked:false,
    permissions:{text:false,images:false,mapDigitisation:false,aiProcessing:false}}});
