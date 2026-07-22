Requirements.md

The system should present a web page with a search bar.
The user can type, in plain freeform text, a geographical feature.
Upon pressing enter, the system queries its database cache of processed features and returns one or more matching results.
The matching results are displayed as a selectable list of candidate features found in the database of cached results.
Two things can happen here. The user selects from the list and the feature is displayed.
Or the user can choose the "Not found" option. The system then responds that their search entry may appear at another time and they are invited to try again after 24 hours. The system notes the search outcome and queues the feature for further pre-processing. In the background, the raw data is queried for this feature and pre-processing proceeds. Once pre-processing concludes, the system updates its main database of cached results.

A separate sub system handles the pre-processing. Pre-processing is whereby the system attempts to identify a region extent by using osm data, wikipedia, federal, state and local government records and other sources of data identified a useful. 

pre-processing is triggered by un matched search requests as well as manually by the system administrator.