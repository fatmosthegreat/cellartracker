# The Cellar

My wine cellar, as a list you can browse: **[fatmosthegreat.github.io/cellartracker](https://fatmosthegreat.github.io/cellartracker/)**

It's set out like a restaurant wine list: what's in the cellar, what's on its way, and what's been opened.

## Features

**Browsing the cellar**
- **In the cellar:** every bottle, with its vintage, producer, region, grape, price paid and drinking window, grouped by colour.
- **On order:** bottles bought but not here yet, marked for collection or delivery, with the date they're due. Their drinking window shows once they arrive.
- **When to open:** a timeline of drinking windows, with a line for today, kept short at up to 5 bottles. Chips pick which: *Pinned* (bottles pinned from Edit), *Opening* next year, *Closing* this year or next, and *Overdue*; a chip only shows when it has a bottle. Each bottle is marked *Drink now*, *Not ready* or *Past its window*.
- **Search** by producer, wine, region, grape, colour or vintage. Every word you type must match, so "pinot 2018" finds the 2018 Pinot Noirs, and accents don't matter, so "romanee" finds "Romanée". Start with "notes" to search the tasting notes of opened bottles instead, e.g. "notes corked".
- **Filters** for everything, In the cellar, On order and Consumed.

**Bottles already opened**
- **Consumed:** every bottle opened, newest first.
- **Tasting cards:** tap a bottle to see its rating, tasting notes, region, grape, the date it was opened, the price and when it was bought.
- **Drinking history:** how many bottles, average rating, money spent, the best bottle, and favourite producers and grapes.

**Anywhere**
- **Print the list:** a clean, menu-style printout, or a PDF from the print dialog. Search first to print only some wines (say "chardonnay" or "vosne romanee"), then pick the sections (in the cellar, on order, consumed), only the ones to drink now, and whether prices and drinking windows show.
- **Home-screen app:** on a phone, **Add to Home Screen** opens it full-screen with its own icon.
- **Light and dark mode**, following your device.

**For me, the owner**
- **Editing:** add, edit, record opened bottles and mark orders as arrived from the page, after logging in with a passkey. Quick changes like +1 bottle can be undone from the message that confirms them, and a half-filled form asks before it's closed.
- **✨ Fill in with AI:** when adding a bottle, type a rough name (spelling mistakes are fine) or take or choose a photo of the label (shown as a preview you can remove), and the form fills in the producer, wine, vintage, colour, grape and region it finds, without wiping anything you've typed, ready to check and save.
- **Hide from friends:** keep particular bottles out of the public list.
- **⚙️ Settings:** choose what friends see: prices, where a bottle is, order details, cellar notes and tasting notes can each be hidden. Hidden details are never sent to anyone who isn't logged in; a hidden price shows as **. Prices are hidden to start with.
- **Telegram bot:**
  - look up the cellar from Telegram (everything, what's ready to drink, windows closing soon, what's on order, search and counts), see what the cellar or part of it is worth, or what you've opened (e.g. /value burgundy, /value consumed pinot noir), search past tasting notes (/notes), and record opened or arrived bottles (opening a bottle asks you to confirm first)
  - send a photo of a label, or type a wine's name with /add (spelling mistakes are fine, and the price can follow a /, e.g. /add 2019 rousseau gevrey / 150), to add that bottle: the bot works out the producer, wine, vintage, colour, grape and region, and shows a draft listing every detail (the missing ones marked) to check, fix or retry before anything is added. Changes are typed plainly, e.g. `vintage 2019, price 150` or `2028-2040`, as a reply or just as the next message
  - a bottle you've ordered is added the same way with /order: one tap on the draft says whether you're collecting it or having it delivered, then the bot asks when it's due (e.g. 5 Dec, friday, tomorrow 3pm)
  - reminders when a wine's drinking window opens
  - a reminder six months before a window closes
  - a reminder the day before and the day bottles on order are due to be collected or delivered, and a weekly nudge while they're overdue or have no due date
  - guests can look up the cellar too, by sending the bot a join phrase I give them, without seeing hidden bottles or changing anything

The list is read-only for visitors. The data lives in a Google Sheet.
