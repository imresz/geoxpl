Domain model.md

Unless otherwise stated below, geographical features have a name and an approximate boundary 

River:
name
approximate_start_point
approximate_end_point
tributaries
intermediate_lakes

Valley:
name
approx_boundary
confidence


Gorge:
name
approx_boundary
line_of_max_depth

Volcano:
name
approx_boundary_of_base
approx_boundary_cone
extinct_or_active

WalkingTrack:
name
geographic_region
start_point
end_point


MountainRange:
name
approx_boundary
ridgeline
confidence
source
subranges
parent_range


Road:
name
geometry
start_point
end_point
surface
gradient_profile

