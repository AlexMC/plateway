-- Job progress (U7): the stages a job has entered, in order, each with the time it started, and the step within the
-- current stage ("Plate 3 of 8").
ALTER TABLE jobs ADD COLUMN stages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stages));
ALTER TABLE jobs ADD COLUMN detail TEXT;
