const checks = (names, start, end, context = {}) => [
  ['endpoint', start, 'Candidate start junction; present-day terminal signage is unverified.', context.start ?? null],
  ...names.slice(1).map((name, i) => [
    'turn', `${names[i]} / ${name}`,
    context[name]?.note ?? 'The road records connect here. Current signed movements are unverified.',
    context[name]?.url ?? null
  ]),
  ['endpoint', end, 'Candidate end junction; present-day terminal signage is unverified.', context.end ?? null]
];

function plan(names, start, end, from, to, context, signage, signageUrl) {
  return { names, starts: [from], ends: [to], checks: checks(names, start, end, context), signage, signageUrl };
}

export const metroExpansion = {
  '4': plan(
    ['DAVEY STREET','BAXTER STREET','CRANBOURNE ROAD','CRANBOURNE-FRANKSTON ROAD','SLADEN STREET'],
    'Nepean Highway / Davey Street', 'Sladen Street / South Gippsland Highway', 47651364, 2404244, {},
    'Frankston to Cranbourne candidate from the 2015 route map and Vicmap. The independent photo record shows local junction signs, not every current Route 4 shield.',
    'https://www.expressway.net.au/gallery/roads/vic/metropolitanroutes/mr4/index.html'
  ),
  '14': plan(
    ['SOUTH ROAD','DINGLEY BYPASS','KINGSTON ROAD','HEATHERTON ROAD','ROBINSON ROAD','KING ROAD'],
    'Beach Road / South Road', 'King Road / Harkaway Road', 70690408, 72931726, {
      end: 'https://prov.vic.gov.au/archive/file-viewer/196334F1-FDF8-11EA-BE8C-E9038D964D0E/0',
      'DINGLEY BYPASS': {
        note:'The bypass opened in 2016, after the baseline map. This candidate uses the newer road connection, but current shields are unverified.',
        url:'https://bigbuild.vic.gov.au/__data/assets/pdf_file/0008/606518/Appendix-A_Transport.pdf'
      },
      'KINGSTON ROAD': {
        note:'Newer works documentation confirms the mapped junction, not the signed Route 14 turn.',
        url:'https://bigbuild.vic.gov.au/__data/assets/pdf_file/0015/1011408/SRL-East-Stabling-Network-Facility-UDLP.pdf'
      }
    },
    'Current-network interpretation of the metropolitan corridor, not a reconstruction of the 2015 road layout. The Dingley Bypass movement and the Harkaway endpoint still need sign evidence.',
    'https://bigbuild.vic.gov.au/projects/roads/south-road-upgrade'
  ),
  '17': plan(
    ['BURKE ROAD N','BURKE ROAD','DANDENONG ROAD','GRANGE ROAD','JASPER ROAD'],
    'Lower Heidelberg Road / Burke Road North', 'Jasper Road / South Road', 2290500, 47388861, {
      start:'https://www.banyule.vic.gov.au/files/assets/public/v/1/planning/major-works/321-heidelberg-road/traffic-impact-assessment.pdf'
    },
    'Dated sign photographs identify Burke Road as Route 17 at Glen Iris. They do not verify current signing along the entire Eaglemont to Moorabbin candidate.',
    'https://www.expressway.net.au/gallery/roads/vic/alphanumeric/m1_a1/08_hawthorn-mtwaverley/index.html'
  ),
  '19': plan(
    ['GLENFERRIE ROAD','DANDENONG ROAD','HAWTHORN ROAD','NEPEAN HIGHWAY','CUMMINS ROAD','BLUFF ROAD'],
    'Cotham Road / Glenferrie Road', 'Bluff Road / Balcombe Road', 2309115, 15596906, {
      'DANDENONG ROAD': {
        note:'Council documents corroborate the junction area. The short jog to Hawthorn Road and its current route signing need checking.',
        url:'https://www.stonnington.vic.gov.au/files/assets/public/v/1/about/council-meetings/archive/2019/3-june/cl_03062019_agn.pdf'
      }
    },
    'The 2015 corridor is matched from Kew to Black Rock. Its current signed termini and any overlaps on Dandenong Road or Nepean Highway are unverified.'
  ),
  '21': plan(
    ['GRANGE ROAD','LOYOLA GROVE','MADDEN GROVE','SWAN STREET','WALLEN ROAD','POWER STREET','DENMARK STREET','PRINCESS STREET','CHANDLER HIGHWAY','GRANGE ROAD','DAREBIN ROAD','STATION STREET','ALBERT STREET','BOLDREWOOD PARADE','BROADWAY'],
    'Toorak Road / Grange Road', 'Broadway / High Street', 2324508, 57950245, {
      'CHANDLER HIGHWAY': {
        note:'The candidate follows the motor-road network after the bridge upgrade. The historical bridge is now a walking and cycling path.',
        url:'https://bigbuild.vic.gov.au/projects/roads/chandler-highway-upgrade'
      }
    },
    'Toorak to Reservoir candidate. Older roadside evidence does not establish current signing after the Chandler Highway rebuild. This is not the Vicmap tag 21 on the Cobb Highway corridor.',
    'https://www.expressway.net.au/gallery/roads/vic/metropolitanroutes/mr21/index.html'
  )
};
