-- Performance Lab: big tables with ONLY primary keys and foreign keys.
-- Adding the right indexes is the learner's job.
CREATE SCHEMA perf;

CREATE TABLE perf.customers (
  id         bigint PRIMARY KEY,
  email      text        NOT NULL,
  full_name  text        NOT NULL,
  country    text        NOT NULL,
  status     text        NOT NULL,   -- active 90% / inactive 9% / banned 1%
  twitter    text        NOT NULL,   -- '' for ~97% of customers
  created_at timestamptz NOT NULL
);

INSERT INTO perf.customers
SELECT g,
       CASE WHEN seed.rnd(g, 1) < 0.3 THEN 'User' || g || '@Example.com' ELSE 'user' || g || '@example.com' END,
       seed.pick(ARRAY['An','Binh','Chi','Dung','Giang','Hoa','Khanh','Linh','Minh','Nam','Oanh','Phuc','Quang','Son',
                       'Trang','Uyen','Vy','Alice','Bob','Carol','Dave','Erin','Frank','Grace','Heidi','Ivan','Judy',
                       'Mallory','Oscar','Peggy','Trent','Victor'], g, 2)
         || ' ' ||
       seed.pick(ARRAY['Nguyen','Tran','Le','Pham','Hoang','Huynh','Phan','Vu','Vo','Dang','Bui','Do','Ho','Ngo',
                       'Duong','Ly','Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Lopez',
                       'Wilson'], g, 3),
       CASE WHEN c < 0.30 THEN 'VN' WHEN c < 0.50 THEN 'US' WHEN c < 0.60 THEN 'JP' WHEN c < 0.68 THEN 'DE'
            WHEN c < 0.75 THEN 'GB' WHEN c < 0.81 THEN 'FR' WHEN c < 0.86 THEN 'SG' WHEN c < 0.90 THEN 'AU'
            WHEN c < 0.93 THEN 'KR' WHEN c < 0.95 THEN 'CA' WHEN c < 0.97 THEN 'BR' WHEN c < 0.985 THEN 'IN'
            WHEN c < 0.995 THEN 'NZ' ELSE 'IS' END,
       CASE WHEN s < 0.90 THEN 'active' WHEN s < 0.99 THEN 'inactive' ELSE 'banned' END,
       CASE WHEN seed.rnd(g, 6) < 0.03 THEN '@fan' || g ELSE '' END,
       timestamptz '2020-01-01 00:00+00' + (g * (6 * 365.0 / 200000) + seed.rnd(g, 7)) * interval '1 day'
FROM generate_series(1, 200000) g
CROSS JOIN LATERAL (SELECT seed.rnd(g, 4) AS c, seed.rnd(g, 5) AS s) r;

CREATE TABLE perf.products (
  id         bigint PRIMARY KEY,
  sku        text          NOT NULL,
  name       text          NOT NULL,
  category   text          NOT NULL,
  price      numeric(10,2) NOT NULL,
  created_at timestamptz   NOT NULL
);

INSERT INTO perf.products
SELECT g,
       'SKU-' || lpad(g::text, 6, '0'),
       seed.pick(ARRAY['Cozy','Smart','Compact','Deluxe','Eco','Rugged','Classic','Mini','Ultra','Silent','Portable','Vintage'], g, 41)
         || ' ' || seed.pick(ARRAY['Bamboo','Steel','Cotton','Ceramic','Leather','Glass','Oak','Carbon','Wool','Copper'], g, 42)
         || ' ' || seed.pick(ARRAY['Lamp','Kettle','Backpack','Chair','Speaker','Mug','Blanket','Watch','Desk','Bottle',
                                  'Headphones','Jacket','Pan','Keyboard','Tent','Shoes'], g, 43),
       seed.pick(ARRAY['Home','Kitchen','Outdoor','Electronics','Fashion','Office','Sports','Toys','Beauty','Garden',
                       'Books','Music','Pets','Baby','Tools','Auto','Health','Grocery','Travel','Art'], g, 44),
       round((2 + power(seed.rnd(g, 45), 2) * 998)::numeric, 2),
       timestamptz '2020-01-01 00:00+00' + seed.rnd(g, 46) * interval '2000 days'
FROM generate_series(1, 20000) g;

CREATE TABLE perf.orders (
  id          bigint PRIMARY KEY,
  customer_id bigint        NOT NULL,
  status      text          NOT NULL,   -- delivered 78% / shipped 10% / cancelled 10% / pending 2%
  created_at  timestamptz   NOT NULL,   -- 2022-01-01 .. 2025-12-31, grows with id
  total       numeric(12,2) NOT NULL
);

-- Customers only order after they sign up; older customers order more (skewed toward low ids).
INSERT INTO perf.orders
SELECT g,
       1 + floor(power(seed.rnd(g, 11), 1.5) * floor((2 + 4.0 * g / 1000000) / 6 * 200000))::bigint,
       CASE WHEN st < 0.78 THEN 'delivered' WHEN st < 0.88 THEN 'shipped' WHEN st < 0.98 THEN 'cancelled' ELSE 'pending' END,
       timestamptz '2022-01-01 00:00+00' + g * (4 * 365.0 / 1000000) * interval '1 day' + seed.rnd(g, 12) * interval '2 hours',
       round((5 + seed.rnd(g, 13) * 495)::numeric, 2)
FROM generate_series(1, 1000000) g
CROSS JOIN LATERAL (SELECT seed.rnd(g, 14) AS st) r;

CREATE TABLE perf.order_items (
  id         bigint PRIMARY KEY,
  order_id   bigint        NOT NULL,
  product_id bigint        NOT NULL,   -- heavily skewed: low product ids are best sellers
  quantity   int           NOT NULL,
  unit_price numeric(10,2) NOT NULL
);

INSERT INTO perf.order_items
SELECT row_number() OVER (ORDER BY o, i), o, p.id, 1 + floor(seed.rnd(o * 4 + i, 22) * 4)::int, p.price
FROM generate_series(1, 1000000) o
CROSS JOIN LATERAL generate_series(1, 1 + (o % 4)::int) i
JOIN perf.products p ON p.id = 1 + floor(power(seed.rnd(o * 4 + i, 21), 3) * 20000)::bigint
ORDER BY o, i;

CREATE TABLE perf.reviews (
  id          bigint PRIMARY KEY,
  product_id  bigint      NOT NULL,
  customer_id bigint      NOT NULL,
  rating      smallint    NOT NULL,
  body        text        NOT NULL,   -- a few rare phrases: 'overheating' (~0.4%), 'waterproof' (~0.6%)
  created_at  timestamptz NOT NULL
);

WITH w AS (
  SELECT ARRAY['great','quality','price','fast','shipping','love','it','works','as','expected','the','color','is',
               'nice','but','size','runs','small','would','buy','again','not','worth','money','sturdy','cheap',
               'feels','premium','arrived','late','packaging','was','damaged','easy','to','use','battery','lasts',
               'long','comfortable','fits','perfectly','my','kids','gift','recommend','five','stars','okay',
               'product','return','smells','strange','lightweight','durable','design','looks','better'] AS words
)
INSERT INTO perf.reviews
SELECT g,
       1 + floor(power(seed.rnd(g, 51), 2) * 20000)::bigint,
       1 + floor(seed.rnd(g, 52) * 200000)::bigint,
       1 + floor(seed.rnd(g, 53) * 5)::int,
       (SELECT string_agg(w.words[1 + floor(seed.rnd(g * 64 + k, 54) * cardinality(w.words))::int], ' ' ORDER BY k)
          FROM generate_series(1, 6 + (g % 15)::int) k)
         || CASE WHEN seed.rnd(g, 55) < 0.004 THEN ' overheating after a week'
                 WHEN seed.rnd(g, 55) < 0.010 THEN ' waterproof' ELSE '' END,
       timestamptz '2022-01-01 00:00+00' + g * (4 * 365.0 / 100000) * interval '1 day'
FROM generate_series(1, 100000) g, w;

-- Foreign keys after the bulk load (one validating join instead of millions of trigger calls).
-- Note: Postgres does NOT create indexes for foreign key columns. That is on purpose here.
ALTER TABLE perf.orders      ADD FOREIGN KEY (customer_id) REFERENCES perf.customers(id);
ALTER TABLE perf.order_items ADD FOREIGN KEY (order_id)    REFERENCES perf.orders(id);
ALTER TABLE perf.order_items ADD FOREIGN KEY (product_id)  REFERENCES perf.products(id);
ALTER TABLE perf.reviews     ADD FOREIGN KEY (product_id)  REFERENCES perf.products(id);
ALTER TABLE perf.reviews     ADD FOREIGN KEY (customer_id) REFERENCES perf.customers(id);
