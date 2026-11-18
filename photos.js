/* ============================================================================
   Sanctuary photos (photos.html): albums, and every photo with its labels.

   To add photos, run the helper (it makes the full-size and thumbnail WebP
   files and prints the entries to paste below):
     python3 tools/add-photos.py <album-id> <photo files…>
   Files land in photos/<album-id>/. Photos need a signed-in account:
   middleware.js never serves /photos/ to anyone who isn't signed in.

   Albums are listed in the order below (first = shown first).
   Each photo:
     file      photos/<album>/<name>.webp; the thumbnail is <name>-thumb.webp
     album     an album id from PHOTO_ALBUMS
     labels    the filter chips: who or what is in it ("Speakers", "Team",
               "Booth", "Awards", "Venue"…). Use the same spelling every
               time; each distinct label becomes a filter.
     caption   optional, one line
     w, h      the image size in pixels (the helper fills these in)
   ========================================================================== */
var PHOTO_ALBUMS = [
  {
    id: 'pal-forward-2026',
    title: 'PAL Forward 2026',
    date: '',               /* YYYY-MM-DD of the event, once confirmed */
    place: '',
    description: 'Photos from the PAL Forward 2026 event.'
  }
];

var PHOTOS = [
  /* PAL Forward 2026: photos go here, first in the gallery */
];
