# geoxpl Requirements.md


At a high level when I search for a geographic feature:
I want to know:			
	the path of the feature shown as a line on an interactive map if the geometry is composed of lines		
	the extent of the feature shown as an irregular polygon if the geometry is spatial		
	
			
The data comes from
	government sources		
	open-source sources		
	private sources with public access		
			
The system			
	receieves a search query		
	checks cached data	or	pre processes geographical features and creates cached data
	displays data		
	receives feedback		


The system should present a web page with a search bar.
The user can type, in plain freeform text, a geographical feature's name and also select the feature type from a drop down list.
Upon pressing enter, the system queries its database cache of processed features and returns one or more matching results.
The matching results are displayed as a selectable list of candidate features found in the database of cached results.
Two things can happen here. The user selects from the list and the feature is displayed.
Or the user can choose the "Not found" option. The system then responds that their search entry may appear at another time and they are invited to try again after 24 hours. The system notes the search outcome and queues the feature for further pre-processing. In the background, the raw data is queried for this feature and pre-processing proceeds. Once pre-processing concludes, the system updates its main database of cached results.

A separate sub system handles the pre-processing. Pre-processing is whereby the system attempts to identify a region extent by using osm data, wikipedia, federal, state and local government records and other sources of data identified a useful. The preprocessing can comprise specialized geographical features "engines" which support the search engine. For example the would be a rivers geography engine, a roads engine, a mountain range etc. Each engine uses its own form of geographic rules for identifying regions. The extent of a region does not have to be exact. Provenance means the source of the info is traceable but where there is contradiction or controversy, boundaries can be estimated and a low, medium or high confidence level attached. 

Pre-processing can be triggered by unmatched search requests as well as manually by the system administrator.

Future information about features:
	gradients	
	surface type		
	current status - seasonal open/close, in flood or dry, weather warnings		
