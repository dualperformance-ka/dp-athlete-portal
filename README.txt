DP Athlete Portal — mobile outdoor-mode shell fix

Replace these three files in the repository, preserving their paths:

  public/index.html
  public/styles.css
  public/sw.js

Changes:

  1. Makes .top-shell use the light outdoor-mode background at every
     viewport width, including 430px mobile screens.
  2. Bumps the stylesheet URL from styles.css?v=30 to styles.css?v=31.
  3. Bumps the service-worker cache from dp-athlete-v39 to v40 and
     pre-caches styles.css?v=31.

No other source changes are included.
