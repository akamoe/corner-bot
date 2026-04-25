-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  emoji text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);
CREATE TABLE public.item_topping_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  menu_item_id uuid,
  group_id uuid,
  CONSTRAINT item_topping_groups_pkey PRIMARY KEY (id),
  CONSTRAINT item_topping_groups_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id),
  CONSTRAINT item_topping_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.topping_groups(id)
);
CREATE TABLE public.item_toppings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  menu_item_id uuid,
  topping_id uuid,
  CONSTRAINT item_toppings_pkey PRIMARY KEY (id),
  CONSTRAINT item_toppings_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id),
  CONSTRAINT item_toppings_topping_id_fkey FOREIGN KEY (topping_id) REFERENCES public.toppings(id)
);
CREATE TABLE public.menu_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid,
  name text NOT NULL,
  description text,
  price numeric NOT NULL,
  image_url text,
  is_available boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT menu_items_pkey PRIMARY KEY (id),
  CONSTRAINT menu_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id)
);
CREATE TABLE public.order_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid,
  menu_item_id uuid,
  item_name text NOT NULL,
  item_price numeric NOT NULL,
  quantity integer DEFAULT 1,
  customization text,
  CONSTRAINT order_items_pkey PRIMARY KEY (id),
  CONSTRAINT order_items_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id),
  CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id)
);
CREATE TABLE public.orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_code text NOT NULL DEFAULT ('ORD-'::text || upper("substring"((gen_random_uuid())::text, 1, 5))) UNIQUE,
  user_id uuid,
  slot_id uuid,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'preparing'::text, 'ready'::text, 'picked_up'::text, 'cancelled'::text])),
  total_amount numeric,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT orders_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.pickup_slots(id)
);
CREATE TABLE public.pickup_slots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL,
  slot_time time without time zone NOT NULL,
  max_orders integer DEFAULT 15,
  is_active boolean DEFAULT true,
  CONSTRAINT pickup_slots_pkey PRIMARY KEY (id)
);
CREATE TABLE public.staff (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  telegram_hash text NOT NULL UNIQUE,
  telegram_username text,
  role text DEFAULT 'cashier'::text CHECK (role = ANY (ARRAY['cashier'::text, 'admin'::text])),
  is_active boolean DEFAULT true,
  added_at timestamp with time zone DEFAULT now(),
  telegram_id text,
  CONSTRAINT staff_pkey PRIMARY KEY (id)
);
CREATE TABLE public.topping_group_options (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id uuid,
  topping_id uuid,
  CONSTRAINT topping_group_options_pkey PRIMARY KEY (id),
  CONSTRAINT topping_group_options_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.topping_groups(id),
  CONSTRAINT topping_group_options_topping_id_fkey FOREIGN KEY (topping_id) REFERENCES public.toppings(id)
);
CREATE TABLE public.topping_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  selection_type text NOT NULL CHECK (selection_type = ANY (ARRAY['single'::text, 'multiple'::text])),
  required boolean DEFAULT false,
  CONSTRAINT topping_groups_pkey PRIMARY KEY (id)
);
CREATE TABLE public.toppings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  tag text,
  CONSTRAINT toppings_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  telegram_hash text NOT NULL UNIQUE,
  anonymous_token text NOT NULL DEFAULT "substring"((gen_random_uuid())::text, 1, 8) UNIQUE,
  loyalty_points integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  telegram_id text,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);