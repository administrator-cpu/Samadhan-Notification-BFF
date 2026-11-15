-- OPTIONAL: a dedicated least-privilege DB user instead of reusing the backend's user.
-- Run as a superuser in the samadhan database, then put these credentials in .env.
CREATE ROLE samadhan_notify LOGIN PASSWORD 'asdfghjkl;';

GRANT CONNECT ON DATABASE samadhandb TO samadhan_notify;
GRANT USAGE ON SCHEMA public TO samadhan_notify;
GRANT SELECT ON public.tickets, public.customers, public.employees, public.users,
  public.issue_categories, public.ticket_events, public.sessions, public.push_tokens
  TO samadhan_notify;

-- The service creates and owns its own schema.
CREATE SCHEMA IF NOT EXISTS notif AUTHORIZATION samadhan_notify;
