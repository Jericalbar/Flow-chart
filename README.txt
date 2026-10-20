FlowChart Studio - PNG editable import fix

1. Back up your existing project folder first.
2. Replace index.html, script.js and style.css with these files.
3. Open index.html with internet access (Tesseract.js/OpenCV.js load from CDNs).
4. File > Import PNG flowchart.
5. Choose Cancel at the reference-image prompt to hide the original flat PNG and inspect reconstructed objects.

Important limitations:
- OCR fallback converts recognized text lines into independent editable process boxes if OpenCV fails or detects no outlines.
- It cannot perfectly infer every shape or arrow from every PNG. Review and rebuild connectors/shape types where needed.
- This package has passed JavaScript syntax validation; browser-level recognition still depends on internet/CDN availability and the PNG's clarity.
