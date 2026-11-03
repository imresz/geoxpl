import {createPlm25Adapter,plm25Endpoint} from './plm25.js';

export const stateParkVersion='victorian-state-park/1';
export const stateParkSource={name:'Victorian state parks - PLM25',type:'state_park',format:'vic-state-park',url:plm25Endpoint,nameField:'name',idField:'plm_id',licence:'CC BY 4.0',attribution:'State of Victoria, Department of Energy, Environment and Climate Action (PLM25)',version:'PLM25; retrieved source snapshot',completeness:'partial',aliases:[],notes:'Official Victorian public land management polygons at 1:25,000. Only current STATE PARK parcels are imported. National parks, state forests and proposed classifications are not substituted. https://discover.data.vic.gov.au/dataset/public-land-management-plm25'};
const adapter=createPlm25Adapter({type:'state_park',format:'vic-state-park',version:stateParkVersion,designation:'STATE PARK',managementGroup:'NATIONAL PARKS ACT AND NATURE CONSERVATION RESERVES',title:'State Park',noun:'park',plural:'state parks',slug:'state-park',metadataKey:'statePark'});
export const listStateParks=adapter.list;
export const importStatePark=adapter.importFeature;
export const processStatePark=adapter.process;
