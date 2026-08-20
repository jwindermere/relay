CREATE TABLE relay.runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO relay.runtime_state (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
