namespace :partition do
  # Define a task that accepts an argument
  desc "Run tests partitioned by index"
  task :test, [:index, :total] => :environment do |task, args|
    raise "Must provide index and total" unless args[:index] && args[:total]

    index = args[:index].to_i
    total = args[:total].to_i

    $LOAD_PATH.unshift 'lib'
    $LOAD_PATH.unshift 'test'

    test_files = Dir["test/**/*_test.rb"].
      sort.
      select.
      with_index do |el, i|
        i % total == index
      end.
      each do |test_file|
        load test_file
      end
  end
end
