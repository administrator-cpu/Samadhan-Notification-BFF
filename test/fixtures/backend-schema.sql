-- Minimal copy of the tool-samadhan tables the service reads (columns it uses only).
DROP SCHEMA IF EXISTS notif CASCADE;
DROP TABLE IF EXISTS public.push_tokens, public.sessions, public.ticket_events, public.tickets,
  public.issue_categories, public.customers, public.employees, public.users CASCADE;
DROP TYPE IF EXISTS user_role, ticket_status;
CREATE TYPE user_role AS ENUM ('USER', 'SUPPORT_AGENT', 'ADMIN', 'SALES', 'GUEST');
CREATE TYPE ticket_status AS ENUM ('OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED');
CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL, role user_role NOT NULL DEFAULT 'USER', is_active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE public.employees (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id));
CREATE TABLE public.customers (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id));
CREATE TABLE public.issue_categories (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);
CREATE TABLE public.tickets (
  id BIGINT PRIMARY KEY, ticket_no VARCHAR(20) NOT NULL, status ticket_status NOT NULL DEFAULT 'OPEN',
  customer_id BIGINT NOT NULL REFERENCES public.customers(id), current_assigned_employee_id BIGINT REFERENCES public.employees(id),
  primary_issue_category_id BIGINT REFERENCES public.issue_categories(id), rating_feedback TEXT, problem_side VARCHAR(100), telco_sr_number VARCHAR(100));
CREATE TABLE public.ticket_events (id BIGINT PRIMARY KEY, ticket_id BIGINT NOT NULL, actor_user_id BIGINT, event_type VARCHAR(255) NOT NULL, message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE public.sessions (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, jti UUID NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE public.push_tokens (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, token TEXT NOT NULL UNIQUE, platform VARCHAR(50), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

INSERT INTO public.users (id, name, role, is_active) VALUES
  (1, 'Asha Admin', 'ADMIN', true),
  (2, 'Ravi Agent', 'SUPPORT_AGENT', true),
  (3, 'Meera Agent', 'SUPPORT_AGENT', true),
  (4, 'Acme Corp', 'USER', true),
  (5, 'Old Admin', 'ADMIN', false);
INSERT INTO public.employees (id, user_id) VALUES (10, 2), (11, 3);
INSERT INTO public.customers (id, user_id) VALUES (20, 4);
INSERT INTO public.issue_categories (id, name) VALUES (1, 'Internet Down');
INSERT INTO public.tickets (id, ticket_no, status, customer_id, current_assigned_employee_id, primary_issue_category_id) VALUES
  (100, 'TCK-1042', 'IN_PROGRESS', 20, 10, 1),
  (101, 'TCK-1043', 'OPEN', 20, NULL, 1);
INSERT INTO public.ticket_events (id, ticket_id, actor_user_id, event_type, message) VALUES
  (500, 100, 2, 'AGENT_REPLY', 'We have reset the port on our side. Please restart your router and confirm.'),
  (501, 100, NULL, 'AUTOMATED_UPDATE', 'We are performing detailed troubleshooting.');
INSERT INTO public.sessions (user_id, jti, expires_at, revoked) VALUES
  (4, '11111111-1111-4111-8111-111111111111', now() + interval '1 day', false),
  (4, '22222222-2222-4222-8222-222222222222', now() + interval '1 day', true),
  (2, '33333333-3333-4333-8333-333333333333', now() + interval '1 day', false),
  (3, '44444444-4444-4444-8444-444444444444', now() + interval '1 day', false),
  (1, '55555555-5555-4555-8555-555555555555', now() + interval '1 day', false);
