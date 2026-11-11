/* Office Screens settings. The key below is Supabase's public (anon) key: it is
   meant to be in web pages. What it can do is limited by the database's access
   rules: anyone can read what the TVs show and check a TV in; only signed-in
   admins can change anything. */
window.OS_CONFIG = {
  url: 'https://dnuvbbddwfewvcmhpamx.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudXZiYmRkd2Zld3ZjbWhwYW14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0MTQwNDAsImV4cCI6MjEwOTk5MDA0MH0.Q_YGFrC_VydxslkTBNtkAH-fW_hQ988bNjsLvILX0ZM',
  bucket: 'media',
  // Largest file Supabase accepts. Free plan: 50 MB. On Pro, raise the limit in
  // Supabase (Storage > Settings) and change this number to match.
  maxFileMB: 50,
  version: '1.0.0'
};
