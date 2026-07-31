# geoxpl architecture.md
# Logical responsibilities
# Specify workflow


The display layer should:
	present the public and administration web pages;
	use MapLibre to render the base map and GeoXpl geometry;
	present the feature search interfae;	
	display candidate results, featuredetails, provenance and job status.

The search layer should:

	normalise the entered feature name;
	apply the selected feature type;
	search names, approved aliases and route numbers;
	rank matching candidates according to the search contract;
	return disambiguation options when more than one feature matches;
	determine whether an unmatched request is eligible for background processing.

The Geographic API should:
	search the processed-feature catalogue;
	return feature geomed administration operations.

The computational layer should:
	contain Road, River and National Park processors;
	assemble geometry;
	calculate extent and confidence;
	produce provenance-aware processed features.

The background layer should:
	schedule work;
	execute queued jobs;
	discover candidate sources;
	import approved datasets;
	validate updates;
	call the computational processors;
	update job status.

The data layer should:
	source registry and approvals;
	source versions and licences;
	raw and staged geographic data;
	processing jobs;
	processed features;
	provenance and transformation records.

## Request flows

Cached search:
	Display → Geographic API → Search layer →
	Processed-feature catalogue → Geographic API → Display

Uncached search:

	Display → Geographic API → Job store →
	Background worker → Computational processor →
	Processed-feature catalogue

The display checks the Geographic API for job status and retrieves
the feature when processing reaches `ready`.

Administration:

	Administration page → Authenticated Geographic API →
	Source registry or background job coordinator