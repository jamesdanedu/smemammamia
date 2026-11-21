/* ==========================================================================
   PHOTO GALLERY — edit this list to add pictures.

   1. Put the image file into the /images folder (.webp, .jpg or .png all work).
   2. Add a line below with the file name and a short caption.

   Every photo shows in BOTH the slideshow at the top of the Photos page and
   the grid underneath, in the order listed here. Caption is optional ("").
   Aim for images about 1600px on the long side and under ~400 KB each.

   Use DOUBLE quotes, as below, so apostrophes in captions just work:

       { file: "rehearsal-01.jpg", caption: "Donna's taverna takes shape" }   ✅
       { file: 'rehearsal-01.jpg', caption: 'Donna's taverna takes shape' }   ❌

   A single quote ends the text at the apostrophe, which breaks this whole file
   and leaves the photos page empty.
   ========================================================================== */

const PHOTOS = [
    // { file: "rehearsal-01.webp", caption: "First read-through" },
    // { file: "rehearsal-02.jpg", caption: "Blocking the taverna scene" },
];

window.PHOTOS = PHOTOS;
