# geoxpl

This project is for anyone wanting to locate and show the extent of geographical features such as rivers, mountain ranges, reefs etc on a map. The app will be aimed at independent travellers guiding themselves through regions as well as students of geography.

It attempts to make it easier to locate a geographical area, learn more about it and navigate to it.

Google Maps typically places a pin in the middle of a region and does not show the extent.

Examples of the results the app shoudl show are:
Roads highlighted end-to-end.
Rivers highlighted source-to-mouth.
Mountain ranges displaying approximate boundaries with confidence.
Elevation gradients are optional.
Every displayed geometry includes provenance.
Links should be available to further information.


The background system should be able to respond to queries which it cannot resolve by further pre-processing and or further searching for raw data. In other words, it should be a query initiated self-learning system.

A MVP would do the following using Murray River as an example: search “Murray River”, select the right feature from the search results, highlight the intended extent, fit the map to it, and show provenance. If the extent is approximate, note it. 