# The Cellar

My wine cellar, as a list you can browse: **[fatmosthegreat.github.io/cellartracker](https://fatmosthegreat.github.io/cellartracker/)**

It's set out like a restaurant wine list: what's in the cellar, what's on its way, and what's been opened.

## Features

**Browsing the cellar**
- **In the cellar:** every bottle, with its vintage, producer, region, grape, price paid and drinking window, grouped by colour.
- **On order:** bottles bought but not here yet, marked for collection or delivery, with the date they're due.
- **When to open:** a timeline of each bottle's drinking window, with a line for today. Each bottle is marked *Drink now*, *Not ready* or *Past its window*.
- **Search** by producer, wine, grape or region. Accents don't matter, so "romanee" finds "Romanée".
- **Filters** for In the cellar, On order and Consumed.

**Bottles already opened**
- **Consumed:** every bottle opened, newest first.
- **Tasting cards:** tap a bottle to see its rating, tasting notes, the date it was opened, the price and when it was bought.
- **Drinking history:** how many bottles, average rating, money spent, the best bottle, and favourite producers and grapes.

**Anywhere**
- **Print the list:** a clean, menu-style printout of the cellar.
- **Home-screen app:** on a phone, **Add to Home Screen** opens it full-screen with its own icon.
- **Light and dark mode**, following your device.

**For me, the owner**
- **Editing:** add, edit and record opened bottles from the page, after logging in with a passkey. Quick changes like +1 bottle can be undone from the message that confirms them, and a half-filled form asks before it's closed.
- **✨ Fill in with AI:** when adding a bottle, type a rough name (spelling mistakes are fine) or take or choose a photo of the label (shown as a preview you can remove), and the form fills in the producer, wine, vintage, colour, grape and region it finds, without wiping anything you've typed, ready to check and save.
- **Hide from friends:** keep particular bottles out of the public list.
- **Telegram bot:**
  - look up the cellar and record bottles from Telegram (opening a bottle asks you to confirm first)
  - send a photo of a label, or type a wine's name with /add (spelling mistakes are fine, and the price can follow a /, e.g. /add 2019 rousseau gevrey / 150), to add that bottle: the bot works out the producer, wine, vintage, colour, grape and region, asks for the drinking window, and shows a draft to check, fix or retry before anything is added. Changes are typed plainly, e.g. `vintage 2019, price 150` or `2028-2040`, as a reply or just as the next message
  - a bottle that's on order is added the same way: one tap on the draft marks it for collection or delivery, then the bot asks when it's due
  - reminders when a wine's drinking window opens
  - a reminder six months before a window closes
  - a reminder when bottles on order are due to be collected or delivered
  - guests can look up the cellar too, by sending the bot a join phrase I give them, without seeing hidden bottles or changing anything

The list is read-only for visitors. The data lives in a Google Sheet.
