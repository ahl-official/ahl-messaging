-- Cache the WhatsApp profile picture URL for each business number.
-- Populated from Evolution's CONNECTION_UPDATE webhook (state=open
-- payload) and from on-demand fetches via /chat/fetchProfilePictureUrl
-- when the operator opens the Numbers page. Meta numbers don't expose
-- profile pic via Cloud API, so this stays null for them.
alter table business_numbers
  add column if not exists profile_pic_url text;
