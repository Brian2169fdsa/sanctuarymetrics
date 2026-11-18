/* ============================================================================
   Sanctuary photos (photos.html): albums, a few sample photos each, and links
   to the full collections.

   The full photo and video collections are housed in SharePoint. This page
   shows only a handful of sample photos per album and links out to the
   SharePoint folders; it is not where the originals are kept.

   To add sample photos, run the helper (it makes the full-size and
   thumbnail WebP files, drops camera/location metadata, and prints the
   entries to paste below):
     python3 tools/add-photos.py <album-id> <photo files…> --labels "Speakers"
   Files land in photos/<album-id>/. Photos need a signed-in account:
   middleware.js never serves /photos/ to anyone who isn't signed in.

   Albums are listed in the order below (first = shown first). Each album:
     links     the SharePoint folders: { kind, label, url, note }
               kind is 'photos' or 'video' (it becomes a filter)
   Each photo:
     file      photos/<album>/<name>.webp; the thumbnail is <name>-thumb.webp
     album     an album id from PHOTO_ALBUMS
     labels    the filter chips: what's in the photo ("Speakers",
               "Audience", "Networking"…). Same spelling every time; each
               distinct label becomes a filter.
     caption   optional, one line
     w, h      the image size in pixels (the helper fills these in)
   ========================================================================== */
var PHOTO_ALBUMS = [
  {
    id: 'pal-forward-2026',
    title: 'PAL Forward 2026',
    date: '',               /* YYYY-MM-DD of the event, once confirmed */
    year: '2026',
    place: '',
    description: 'A few sample photos from PAL Forward 2026. The full photo and video collections are in SharePoint.',
    links: [
      { kind: 'photos', label: 'Photos, watermarked', note: 'With the Sanctuary watermark: use these for social media and public posts.',
        url: 'https://sanctuaryrecoverycenters48-my.sharepoint.com/:f:/g/personal/breinhart_sanctuaryrecoverycenters_com/IgDhNqNdsX2aSqFwfPpNK3eOAQ_GmvrQXxDtieVlNO-8W7w?email=breinhart%40sanctuaryrecoverycenters.com&e=bGPMYP' },
      { kind: 'photos', label: 'Photos, no watermark', note: 'Originals without the watermark: for print and design work.',
        url: 'https://sanctuaryrecoverycenters48-my.sharepoint.com/:f:/g/personal/breinhart_sanctuaryrecoverycenters_com/IgDw1s7kaS75SZQU_TKYSGijAfalvcAzpsxvUbvQLad70zM?email=breinhart%40sanctuaryrecoverycenters.com&e=i5GAkU' },
      { kind: 'video', label: 'Video', note: 'Video content from the event.',
        url: 'https://sanctuaryrecoverycenters48-my.sharepoint.com/:f:/g/personal/breinhart_sanctuaryrecoverycenters_com/IgCeYaMpec0nSaE9fUT5aXVEAfFLflJfwaABSGe5TFQ_dWc?email=breinhart%40sanctuaryrecoverycenters.com&e=4fmbH2' }
    ]
  }
];

var PHOTOS = [
  /* PAL Forward 2026: sample photos (watermarked); the full set is in SharePoint */
  { file: 'photos/pal-forward-2026/pal-forward-speaker.webp', album: 'pal-forward-2026', labels: ['Speakers'],
    caption: 'On stage: PAL, You Are Not Alone', w: 2000, h: 1282 },
  { file: 'photos/pal-forward-2026/pal-forward-networking.webp', album: 'pal-forward-2026', labels: ['Networking'],
    caption: 'Guests catching up in the lobby', w: 2000, h: 1333 },
  { file: 'photos/pal-forward-2026/pal-forward-audience-1.webp', album: 'pal-forward-2026', labels: ['Audience'],
    caption: 'Applause from the audience', w: 1500, h: 1001 },
  { file: 'photos/pal-forward-2026/pal-forward-audience-2.webp', album: 'pal-forward-2026', labels: ['Audience'],
    caption: 'The audience during a talk', w: 1500, h: 989 }
];
