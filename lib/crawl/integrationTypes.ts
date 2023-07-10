type request = {
  method: string;
  url: string;
};

enum Status {
  ok = 200,
  created = 201,
  accepted = 202,
  no_content = 204,
  moved_permanently = 301,
  found = 302,
  see_other = 303,
  not_modified = 304,
  temporary_redirect = 307,
  bad_request = 400,
  unauthorized = 401,
  forbidden = 403,
  not_found = 404,
  method_not_allowed = 405,
  not_acceptable = 406,
  conflict = 409,
  gone = 410,
  unprocessable_entity = 422,
  internal_server_error = 500,
}

type assert_response = {
  status: Status;
};

type assert_select = {
  selector: string;
  expected?: string;
};
