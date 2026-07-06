-- Consent-safe display name: full name only with explicit public_name consent,
-- otherwise initials ('John Smith' → 'J.S.'). Never leaks the full name.
create or replace function public_person_name(full_name text, consent jsonb) returns text
  language sql immutable as $$
    select case
      when coalesce((consent->>'public_name')::boolean, false) then full_name
      else (
        select string_agg(left(word, 1) || '.', '')
        from regexp_split_to_table(trim(full_name), '\s+') as word
        where word <> ''
      )
    end
  $$;
